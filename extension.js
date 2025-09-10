"use strict";

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import Gvc from "gi://Gvc";
import GObject from "gi://GObject";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import * as Signals from "resource:///org/gnome/shell/misc/signals.js";

const EXCLUDED_APPLICATION_IDS = [
  "org.gnome.VolumeControl",
  "org.PulseAudio.pavucontrol",
];
const KEYBINDING_KEY_NAME = "keybinding-toggle-mute";
const MICROPHONE_ACTIVE_STYLE_CLASS = "screencast-indicator";

let settings = null;
let microphone;
let audio_player;
let panel_button;

class Microphone extends Signals.EventEmitter {
  constructor() {
    super();
    this.active = null;
    this.stream = null;
    this.muted_changed_id = 0;
    this.mixer_control = new Gvc.MixerControl({ name: "Nothing to say" });
    this.mixer_control.open();
    const refresh_cb = () => {
      this.refresh();
    };
    this.mixer_control.connect("default-source-changed", refresh_cb);
    this.mixer_control.connect("stream-added", refresh_cb);
    this.mixer_control.connect("stream-removed", refresh_cb);
    this.refresh();
  }

  refresh() {
    if (this.stream && this.muted_changed_id) {
      this.stream.disconnect(this.muted_changed_id);
    }
    let was_active = this.active;
    this.active = false;
    this.stream = this.mixer_control.get_default_source();
    if (this.stream) {
      this.muted_changed_id = this.stream.connect("notify::is-muted", () => {
        this.notify_muted();
      });
      let recording_apps = this.mixer_control.get_source_outputs();
      for (let i = 0; i < recording_apps.length; i++) {
        let output_stream = recording_apps[i];
        let application_id = output_stream.get_application_id();
        if (EXCLUDED_APPLICATION_IDS.includes(application_id)) continue;
        this.active = true;
      }
    }
    this.notify_muted();
    if (this.active != was_active) {
      this.emit("notify::active");
    }
  }

  destroy() {
    this.mixer_control.close();
  }

  notify_muted() {
    this.emit("notify::muted");
  }

  get muted() {
    if (!this.stream) return true;
    return this.stream.is_muted;
  }

  set muted(muted) {
    if (!this.stream) return;
    this.stream.change_is_muted(muted);
  }

  get level() {
    if (!this.stream) return 0;
    return this.stream.get_volume() / this.mixer_control.get_vol_max_norm();
  }
}

class AudioPlayer {
  #sound_on;
  #sound_off;

  constructor(dir) {
    this.#sound_on = dir.get_child("sounds/on.ogg");
    this.#sound_off = dir.get_child("sounds/off.ogg");
  }

  #play_sound(sound_file) {
    let player = global.display.get_sound_player();
    player.play_from_file(sound_file, "Toggle mute", null);
  }

  play_on() {
    this.#play_sound(this.#sound_on);
  }

  play_off() {
    this.#play_sound(this.#sound_off);
  }
}

const MicrophonePanelButton = GObject.registerClass(
  { GTypeName: "MicrophonePanelButton" },
  class extends PanelMenu.Button {
    _init(extension) {
      super._init(0.0, `${extension.metadata.name} panel indicator`, false);
      this.icon = new St.Icon({
        icon_name: get_icon_name(false),
        style_class: "system-status-icon",
      });
      this.add_child(this.icon);
      this.connect("button-press-event", (_, event) => {
        if (event.get_button() === 3) {
          extension.openPreferences();
        }
      });
    }
  },
);

function get_icon_name(muted) {
  return muted
    ? "microphone-sensitivity-muted-symbolic"
    : "microphone-sensitivity-high-symbolic";
}

function icon_should_be_visible(microphone_active) {
  let setting = settings.get_value("icon-visibility").unpack();
  switch (setting) {
    case "always":
      return true;
    case "never":
      return false;
    default:
      return microphone.active;
  }
}

function show_osd(text, muted) {
  const monitor = -1;
  const icon = Gio.Icon.new_for_string(get_icon_name(muted));
  Main.osdWindowManager.show(monitor, icon, text);
}

export default class extends Extension {
  enable() {
    settings = this.getSettings();
    microphone = new Microphone();
    audio_player = new AudioPlayer(this.dir);
    panel_button = new MicrophonePanelButton(this);
    panel_button.visible = icon_should_be_visible(microphone.active);
    const indicatorName = `${this.metadata.name} indicator`;
    Main.panel.addToStatusArea(indicatorName, panel_button, 0, "right");

    // força iniciar mutado
    microphone.muted = true;

    microphone.connect("notify::active", () => {
      if (microphone.active) {
        panel_button.icon.add_style_class_name(MICROPHONE_ACTIVE_STYLE_CLASS);
      } else {
        panel_button.icon.remove_style_class_name(
          MICROPHONE_ACTIVE_STYLE_CLASS,
        );
      }
      panel_button.visible = icon_should_be_visible(microphone.active);
    });
    microphone.connect("notify::muted", () => {
      panel_button.icon.icon_name = get_icon_name(microphone.muted);
    });

    // Implementa push-to-talk usando uma abordagem extremamente simples
    this._isMuted = true; // Estado do microfone
    this._outDelay = 2000;
    this._timerId = 0; // ID do timer para poder cancelar


    // Registra keybinding para pressionar (PRESS)
    Main.wm.addKeybinding(
      KEYBINDING_KEY_NAME,
      settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.ALL,
      () => {
        // Alterna o estado do microfone
        if (this._isMuted) {
          // Desmuta o microfone
          this._isMuted = false;
          microphone.muted = false;
          
          if (settings.get_boolean("show-osd"))
            show_osd("Mic ATIVO", false);
          
          // Play sound if enabled
          if (settings.get_boolean("play-feedback-sounds"))
            audio_player.play_on();
        } else if (this._outDelay == 0) {
          // Muta o microfone
          this._isMuted = true;
          microphone.muted = true;

          if (settings.get_boolean("show-osd"))
            show_osd("Microphone muted", true);
          
          // Play sound if enabled
          if (settings.get_boolean("play-feedback-sounds"))
            audio_player.play_off();
        } else {
          // Cancela o timer anterior se existir
          if (settings.get_boolean("show-osd"))
            show_osd("Mic ATIVO", false);
          
          if (this._timerId !== 0) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
          }
          
          // Configura um novo timer
          this._outDelay = 2000;
          this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._outDelay, () => {
            // Muta o microfone após o delay
            this._isMuted = true;
            microphone.muted = true;
            
            this._outDelay = 2000;
            this._timerId = 0;
            return GLib.SOURCE_REMOVE;
          });
        }
      }
    );
    settings.connect("changed::icon-visibility", () => {
      panel_button.visible = icon_should_be_visible(microphone.active);
    });
  }

  disable() {
    Main.wm.removeKeybinding(KEYBINDING_KEY_NAME);
    
    // Cancela o timer se estiver ativo
    if (this._timerId !== 0) {
      GLib.source_remove(this._timerId);
      this._timerId = 0;
    }
    
    Main.panel._rightBox.remove_child(panel_button);
    microphone.destroy();
    microphone = null;
    panel_button.destroy();
    panel_button = null;
  }
}
