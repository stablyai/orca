var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// orca-dictation-shortcut-mode-entry.ts
var orca_dictation_shortcut_mode_entry_exports = {};
__export(orca_dictation_shortcut_mode_entry_exports, {
  dictationShortcutMode: () => dictationShortcutMode,
  dictationShortcutModeSettings: () => dictationShortcutModeSettings
});
module.exports = __toCommonJS(orca_dictation_shortcut_mode_entry_exports);

// src/shared/dictation-shortcut-mode.ts
function dictationShortcutMode(voice) {
  if (voice?.dictationMode === "hold") {
    return "hold";
  }
  return voice?.dictationHoldToRecord === false ? "toggle" : "auto";
}
function dictationShortcutModeSettings(mode) {
  return mode === "hold" ? { dictationMode: "hold", dictationHoldToRecord: false } : { dictationMode: "toggle", dictationHoldToRecord: mode === "auto" };
}
