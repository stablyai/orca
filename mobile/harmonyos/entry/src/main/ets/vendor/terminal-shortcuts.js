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

// orca-terminal-shortcuts-entry.ts
var orca_terminal_shortcuts_entry_exports = {};
__export(orca_terminal_shortcuts_entry_exports, {
  TERMINAL_SHORTCUT_SPECIAL_KEYS: () => TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS,
  buildTerminalShortcutKey: () => buildTerminalShortcutKey,
  describeBuiltInShortcut: () => describeBuiltInShortcut,
  normalizeShortcutKeyInput: () => normalizeShortcutKeyInput,
  terminalAccessoryLayout: () => terminalAccessoryLayout
});
module.exports = __toCommonJS(orca_terminal_shortcuts_entry_exports);

// src/shared/terminal/protocol/input-modes/terminal-modified-enter-encoding.ts
var TERMINAL_KITTY_SHIFT_ENTER_INPUT = "\x1B[13;2u";
var TERMINAL_CTRL_BACKSPACE_INPUT = "";

// orca:orca-diagnostic-translation
var translator;
function withTranslation(next, describe) {
  const previous = translator;
  translator = next;
  try {
    return describe();
  } finally {
    translator = previous;
  }
}
function translate(key, fallback, values) {
  const text = translator?.(key, fallback) ?? fallback;
  return values ? text.replace(/{{(\w+)}}/g, (token, name) => values[name] ?? token) : text;
}

// mobile/src/terminal/key-input/terminal-key-definitions.ts
var SPECIAL_KEY_LABELS = {
  escape: "Esc",
  tab: "Tab",
  enter: "Enter",
  backspace: "\u232B",
  delete: "Del",
  insert: "Ins",
  arrowUp: "\u2191",
  arrowDown: "\u2193",
  arrowLeft: "\u2190",
  arrowRight: "\u2192",
  home: "Home",
  end: "End",
  pageUp: "PgUp",
  pageDown: "PgDn",
  space: "Space",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12"
};
var SPECIAL_KEY_ACCESSIBILITY_LABELS = {
  escape: "Escape",
  tab: "Tab",
  enter: "Enter",
  backspace: "Backspace",
  get delete() {
    return translate("terminal.keyDefinitions.forwardDelete", "Forward delete");
  },
  insert: "Insert",
  get arrowUp() {
    return translate("terminal.keyDefinitions.arrowUp", "Arrow up");
  },
  get arrowDown() {
    return translate("terminal.keyDefinitions.arrowDown", "Arrow down");
  },
  get arrowLeft() {
    return translate("terminal.keyDefinitions.arrowLeft", "Arrow left");
  },
  get arrowRight() {
    return translate("terminal.keyDefinitions.arrowRight", "Arrow right");
  },
  home: "Home",
  end: "End",
  pageUp: "Page up",
  pageDown: "Page down",
  space: "Space",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12"
};
var TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS = [
  "escape",
  "tab",
  "enter",
  "backspace",
  "delete",
  "insert",
  "arrowUp",
  "arrowDown",
  "arrowLeft",
  "arrowRight",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "space",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12"
].map((id) => ({
  id,
  label: SPECIAL_KEY_LABELS[id],
  get accessibilityLabel() {
    return SPECIAL_KEY_ACCESSIBILITY_LABELS[id];
  }
}));
var TERMINAL_ACCESSORY_KEY_DEFINITIONS = [
  { id: "escape", label: "Esc", bytes: "\x1B", accessibilityLabel: "Escape" },
  { id: "tab", label: "Tab", bytes: "	", accessibilityLabel: "Tab" },
  { id: "enter", label: "Enter", bytes: "\r", accessibilityLabel: "Enter" },
  { id: "shiftTab", label: "Shift+Tab", bytes: "\x1B[Z", accessibilityLabel: "Shift Tab" },
  { id: "space", label: "Space", bytes: " ", accessibilityLabel: "Space" },
  { id: "backspace", label: "\u232B", bytes: "\x7F", accessibilityLabel: "Backspace", repeatable: true },
  {
    id: "delete",
    label: "Del",
    bytes: "\x1B[3~",
    get accessibilityLabel() {
      return SPECIAL_KEY_ACCESSIBILITY_LABELS.delete;
    },
    repeatable: true
  },
  {
    id: "arrowUp",
    label: "\u2191",
    bytes: "\x1B[A",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.accessoryArrowUp", "Arrow Up");
    },
    repeatable: true
  },
  {
    id: "arrowDown",
    label: "\u2193",
    bytes: "\x1B[B",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.accessoryArrowDown", "Arrow Down");
    },
    repeatable: true
  },
  {
    id: "arrowLeft",
    label: "\u2190",
    bytes: "\x1B[D",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.accessoryArrowLeft", "Arrow Left");
    },
    repeatable: true
  },
  {
    id: "arrowRight",
    label: "\u2192",
    bytes: "\x1B[C",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.accessoryArrowRight", "Arrow Right");
    },
    repeatable: true
  },
  {
    id: "ctrlC",
    label: "Ctrl+C",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.interruptTerminal", "Interrupt terminal");
    }
  },
  {
    id: "ctrlD",
    label: "Ctrl+D",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.sendEof", "Send EOF");
    }
  },
  {
    id: "ctrlL",
    label: "Ctrl+L",
    bytes: "\f",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.clearScreen", "Clear screen");
    }
  },
  {
    id: "ctrlZ",
    label: "Ctrl+Z",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.suspendProcess", "Suspend process");
    }
  },
  {
    id: "ctrlR",
    label: "Ctrl+R",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.reverseSearch", "Reverse search");
    }
  },
  {
    id: "ctrlA",
    label: "Ctrl+A",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.startOfLine", "Start of line");
    }
  },
  {
    id: "ctrlE",
    label: "Ctrl+E",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.endOfLine", "End of line");
    }
  },
  {
    id: "ctrlW",
    label: "Ctrl+W",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.deleteWordBackward", "Delete word backward");
    }
  },
  {
    id: "ctrlU",
    label: "Ctrl+U",
    bytes: "",
    get accessibilityLabel() {
      return translate("terminal.keyDefinitions.clearLineBeforeCursor", "Clear line before cursor");
    }
  }
];

// mobile/src/terminal/key-input/terminal-accessory-keys.ts
var ESC = "\x1B";
var MODIFIER_LABELS = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift"
};
var MODIFIER_ORDER = ["ctrl", "alt", "shift"];
var SHIFTED_PRINTABLE = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?"
};
var CTRL_PRINTABLE_BYTES = {
  " ": "\0",
  "@": "\0",
  "2": "\0",
  "3": "\x1B",
  "4": "",
  "5": "",
  "6": "",
  "7": "",
  "8": "\x7F",
  "/": "",
  "`": "\0",
  "[": "\x1B",
  "{": "\x1B",
  "\\": "",
  "|": "",
  "]": "",
  "}": "",
  "^": "",
  "~": "",
  _: "",
  "?": "\x7F"
};
var CSI_FINAL_SPECIAL_KEYS = {
  arrowUp: "A",
  arrowDown: "B",
  arrowRight: "C",
  arrowLeft: "D",
  home: "H",
  end: "F",
  f1: "P",
  f2: "Q",
  f3: "R",
  f4: "S"
};
var SS3_BASE_SPECIAL_KEYS = /* @__PURE__ */ new Set(["f1", "f2", "f3", "f4"]);
var CSI_TILDE_SPECIAL_KEYS = {
  insert: 2,
  delete: 3,
  pageUp: 5,
  pageDown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24
};
function buildTerminalShortcutKey(binding) {
  const key = normalizeShortcutKey(binding.key);
  if (!key) {
    return null;
  }
  const modifiers = normalizeModifiers(binding.modifiers);
  const bytes = buildShortcutBytes(key, modifiers);
  if (bytes == null) {
    return null;
  }
  const label = formatShortcutLabel(key, modifiers);
  return {
    label,
    bytes,
    accessibilityLabel: label.replaceAll("+", " ")
  };
}
function normalizeShortcutKeyInput(value) {
  const chars = Array.from(value);
  const firstVisible = chars.find((char) => char !== "\n" && char !== "\r" && char !== "	");
  if (!firstVisible) {
    return null;
  }
  return normalizeShortcutKey(firstVisible);
}
function buildShortcutBytes(key, modifiers) {
  if (key === "space") {
    return buildPrintableShortcutBytes(" ", modifiers);
  }
  const csiFinal = CSI_FINAL_SPECIAL_KEYS[key];
  if (csiFinal) {
    if (SS3_BASE_SPECIAL_KEYS.has(key) && csiModifierParameter(modifiers) === 1) {
      return `${ESC}O${csiFinal}`;
    }
    return buildCsiFinalShortcut(csiFinal, modifiers);
  }
  const csiTilde = CSI_TILDE_SPECIAL_KEYS[key];
  if (csiTilde) {
    return buildCsiTildeShortcut(csiTilde, modifiers);
  }
  if (key === "tab") {
    if (modifiers.includes("shift") && !modifiers.includes("ctrl") && !modifiers.includes("alt")) {
      return `${ESC}[Z`;
    }
    const bytes = "	";
    return modifiers.includes("alt") ? `${ESC}${bytes}` : bytes;
  }
  if (key === "escape") {
    const bytes = ESC;
    return modifiers.includes("alt") ? `${ESC}${bytes}` : bytes;
  }
  if (key === "enter") {
    if (hasOnlyModifier(modifiers, "shift")) {
      return TERMINAL_KITTY_SHIFT_ENTER_INPUT;
    }
    const bytes = "\r";
    return modifiers.includes("alt") ? `${ESC}${bytes}` : bytes;
  }
  if (key === "backspace") {
    if (hasOnlyModifier(modifiers, "ctrl")) {
      return TERMINAL_CTRL_BACKSPACE_INPUT;
    }
    const bytes = modifiers.includes("ctrl") ? "\b" : "\x7F";
    return modifiers.includes("alt") ? `${ESC}${bytes}` : bytes;
  }
  if (isPrintableShortcutKey(key)) {
    return buildPrintableShortcutBytes(key, modifiers);
  }
  return null;
}
function hasOnlyModifier(modifiers, modifier) {
  return modifiers.length === 1 && modifiers[0] === modifier;
}
function buildPrintableShortcutBytes(key, modifiers) {
  const shifted = modifiers.includes("shift") ? applyShift(key) : key;
  let bytes = shifted;
  if (modifiers.includes("ctrl")) {
    const ctrlBytes = controlBytesForPrintable(shifted);
    if (ctrlBytes == null) {
      return null;
    }
    bytes = ctrlBytes;
  }
  return modifiers.includes("alt") ? `${ESC}${bytes}` : bytes;
}
function buildCsiFinalShortcut(final, modifiers) {
  const parameter = csiModifierParameter(modifiers);
  return parameter === 1 ? `${ESC}[${final}` : `${ESC}[1;${parameter}${final}`;
}
function buildCsiTildeShortcut(code, modifiers) {
  const parameter = csiModifierParameter(modifiers);
  return parameter === 1 ? `${ESC}[${code}~` : `${ESC}[${code};${parameter}~`;
}
function csiModifierParameter(modifiers) {
  let parameter = 1;
  if (modifiers.includes("shift")) {
    parameter += 1;
  }
  if (modifiers.includes("alt")) {
    parameter += 2;
  }
  if (modifiers.includes("ctrl")) {
    parameter += 4;
  }
  return parameter;
}
function controlBytesForPrintable(key) {
  const lower = key.toLowerCase();
  if (lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  return CTRL_PRINTABLE_BYTES[key] ?? null;
}
function applyShift(key) {
  if (key >= "a" && key <= "z") {
    return key.toUpperCase();
  }
  if (key >= "A" && key <= "Z") {
    return key;
  }
  return SHIFTED_PRINTABLE[key] ?? key;
}
function normalizeModifiers(modifiers) {
  const selected = new Set(modifiers);
  return MODIFIER_ORDER.filter((modifier) => selected.has(modifier));
}
function normalizeShortcutKey(key) {
  if (SPECIAL_KEY_LABELS[key]) {
    return key;
  }
  if (key.length === 1 && isPrintableShortcutKey(key)) {
    return key >= "A" && key <= "Z" ? key.toLowerCase() : key;
  }
  return null;
}
function isPrintableShortcutKey(key) {
  return key.length === 1 && key >= " " && key <= "~";
}
function formatShortcutLabel(key, modifiers) {
  const modifierLabels = modifiers.map((modifier) => MODIFIER_LABELS[modifier]);
  return [...modifierLabels, displayKeyLabel(key)].join("+");
}
function displayKeyLabel(key) {
  if (SPECIAL_KEY_LABELS[key]) {
    return SPECIAL_KEY_LABELS[key];
  }
  if (key === " ") {
    return "Space";
  }
  return key.length === 1 && key >= "a" && key <= "z" ? key.toUpperCase() : key;
}

// mobile/src/terminal/key-input/terminal-accessory-layout.ts
function builtInIds() {
  return TERMINAL_ACCESSORY_KEY_DEFINITIONS.map((key) => key.id);
}
function defaultPreference(ids = builtInIds(), directionPadAvailable = false) {
  return {
    version: 2,
    orderedBuiltInIds: [...ids],
    visibleBuiltInIds: directionPadAvailable ? ids.filter((id) => !id.startsWith("arrow")) : [...ids],
    directionPadEnabled: true,
    smartRail: false
  };
}
function stringArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every((item) => typeof item === "string") ? value : null;
}
function dedupeKnownIds(ids, builtInSet) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const id of ids) {
    if (!builtInSet.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}
function insertMissingBuiltInIds(ordered, currentBuiltInIds) {
  const present = new Set(ordered);
  const out = [...ordered];
  const inserted = [];
  for (let i = 0; i < currentBuiltInIds.length; i++) {
    const id = currentBuiltInIds[i];
    if (present.has(id)) {
      continue;
    }
    let insertAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const at = out.indexOf(currentBuiltInIds[j]);
      if (at !== -1) {
        insertAt = at + 1;
        break;
      }
    }
    out.splice(insertAt, 0, id);
    present.add(id);
    inserted.push(id);
  }
  return { ordered: out, inserted };
}
function normalizeTerminalAccessoryLayoutPreference(value, currentBuiltInIds = builtInIds(), directionPadAvailable = false) {
  const fallback = defaultPreference(currentBuiltInIds, directionPadAvailable);
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const candidate = {
    version: "version" in value ? value.version : void 0,
    orderedBuiltInIds: "orderedBuiltInIds" in value ? value.orderedBuiltInIds : void 0,
    visibleBuiltInIds: "visibleBuiltInIds" in value ? value.visibleBuiltInIds : void 0,
    knownBuiltInIds: "knownBuiltInIds" in value ? value.knownBuiltInIds : void 0,
    directionPadEnabled: "directionPadEnabled" in value ? value.directionPadEnabled : void 0,
    smartRail: "smartRail" in value ? value.smartRail : void 0
  };
  const builtInSet = new Set(currentBuiltInIds);
  if (candidate.version === 2) {
    const orderedInput = stringArray(candidate.orderedBuiltInIds);
    const visibleInput = stringArray(candidate.visibleBuiltInIds);
    if (!orderedInput || !visibleInput) {
      return fallback;
    }
    const { ordered, inserted } = insertMissingBuiltInIds(
      dedupeKnownIds(orderedInput, builtInSet),
      currentBuiltInIds
    );
    const visibleSet = new Set(dedupeKnownIds(visibleInput, builtInSet));
    for (const id of inserted) {
      visibleSet.add(id);
    }
    return {
      version: 2,
      directionPadEnabled: candidate.directionPadEnabled !== false,
      smartRail: candidate.smartRail === true,
      orderedBuiltInIds: ordered,
      visibleBuiltInIds: ordered.filter((id) => visibleSet.has(id))
    };
  }
  if (candidate.version === 1) {
    const visibleInput = stringArray(candidate.visibleBuiltInIds);
    const knownInput = stringArray(candidate.knownBuiltInIds);
    if (!visibleInput || !knownInput) {
      return fallback;
    }
    const knownInputSet = new Set(knownInput.filter((id) => builtInSet.has(id)));
    const visibleSet = new Set(dedupeKnownIds(visibleInput, builtInSet));
    for (const id of currentBuiltInIds) {
      if (!knownInputSet.has(id)) {
        visibleSet.add(id);
      }
    }
    return {
      version: 2,
      directionPadEnabled: candidate.directionPadEnabled !== false,
      smartRail: candidate.smartRail === true,
      orderedBuiltInIds: [...currentBuiltInIds],
      visibleBuiltInIds: currentBuiltInIds.filter((id) => visibleSet.has(id))
    };
  }
  return fallback;
}
var layoutWriteTurn = Promise.resolve();

// orca-terminal-shortcuts-entry.ts
function terminalAccessoryLayout(value, directionPadAvailable) {
  return normalizeTerminalAccessoryLayoutPreference(value, void 0, directionPadAvailable);
}
function describeBuiltInShortcut(id, translator2) {
  const key = TERMINAL_ACCESSORY_KEY_DEFINITIONS.find((entry) => entry.id === id);
  return withTranslation(translator2, () => key ? { label: key.label, title: key.accessibilityLabel ?? key.label } : { label: id, title: id });
}
