// Why: deriving a virtual key code from a character's own char code collides with editing
// keys — '&' (38) arrives as VK_UP and '.' (46) as VK_DELETE, so Blink runs the caret
// command and silently drops the character. This table maps Orca key names ("a", "&",
// "Ctrl+Shift+K", "Alt+ArrowDown", "F5") to the CDP key event a US-layout keyboard
// would produce; anything it cannot express returns null so the caller can fall back.

const CDP_MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  cmd: 4,
  command: 4,
  meta: 4,
  super: 4,
  win: 4,
  shift: 8
}

// name -> [windowsVirtualKeyCode, key, code, text]
const CDP_NAMED_KEYS: Record<string, [number, string, string, string | null]> = {
  enter: [13, 'Enter', 'Enter', '\r'],
  return: [13, 'Enter', 'Enter', '\r'],
  tab: [9, 'Tab', 'Tab', null],
  backspace: [8, 'Backspace', 'Backspace', null],
  delete: [46, 'Delete', 'Delete', null],
  del: [46, 'Delete', 'Delete', null],
  escape: [27, 'Escape', 'Escape', null],
  esc: [27, 'Escape', 'Escape', null],
  space: [32, ' ', 'Space', ' '],
  spacebar: [32, ' ', 'Space', ' '],
  arrowup: [38, 'ArrowUp', 'ArrowUp', null],
  up: [38, 'ArrowUp', 'ArrowUp', null],
  arrowdown: [40, 'ArrowDown', 'ArrowDown', null],
  down: [40, 'ArrowDown', 'ArrowDown', null],
  arrowleft: [37, 'ArrowLeft', 'ArrowLeft', null],
  left: [37, 'ArrowLeft', 'ArrowLeft', null],
  arrowright: [39, 'ArrowRight', 'ArrowRight', null],
  right: [39, 'ArrowRight', 'ArrowRight', null],
  home: [36, 'Home', 'Home', null],
  end: [35, 'End', 'End', null],
  pageup: [33, 'PageUp', 'PageUp', null],
  pgup: [33, 'PageUp', 'PageUp', null],
  pagedown: [34, 'PageDown', 'PageDown', null],
  pgdn: [34, 'PageDown', 'PageDown', null],
  pgdown: [34, 'PageDown', 'PageDown', null],
  insert: [45, 'Insert', 'Insert', null],
  ins: [45, 'Insert', 'Insert', null],
  contextmenu: [93, 'ContextMenu', 'ContextMenu', null],
  apps: [93, 'ContextMenu', 'ContextMenu', null],
  capslock: [20, 'CapsLock', 'CapsLock', null],
  numlock: [144, 'NumLock', 'NumLock', null],
  scrolllock: [145, 'ScrollLock', 'ScrollLock', null],
  pause: [19, 'Pause', 'Pause', null],
  printscreen: [44, 'PrintScreen', 'PrintScreen', null],
  shift: [16, 'Shift', 'ShiftLeft', null],
  control: [17, 'Control', 'ControlLeft', null],
  ctrl: [17, 'Control', 'ControlLeft', null],
  alt: [18, 'Alt', 'AltLeft', null],
  option: [18, 'Alt', 'AltLeft', null],
  meta: [91, 'Meta', 'MetaLeft', null],
  cmd: [91, 'Meta', 'MetaLeft', null],
  command: [91, 'Meta', 'MetaLeft', null]
}

// Characters a US keyboard produces with shift held, and the base key they share.
const US_SHIFTED_CHARS: Record<string, string> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/'
}

const US_SHIFT_OF: Record<string, string> = {}
for (const shifted of Object.keys(US_SHIFTED_CHARS)) {
  US_SHIFT_OF[US_SHIFTED_CHARS[shifted]] = shifted
}

// char -> [windowsVirtualKeyCode, code], for the keys that are not letters or digits.
const US_PUNCTUATION_KEYS: Record<string, [number, string]> = {
  ' ': [32, 'Space'],
  ';': [186, 'Semicolon'],
  '=': [187, 'Equal'],
  ',': [188, 'Comma'],
  '-': [189, 'Minus'],
  '.': [190, 'Period'],
  '/': [191, 'Slash'],
  '`': [192, 'Backquote'],
  '[': [219, 'BracketLeft'],
  '\\': [220, 'Backslash'],
  ']': [221, 'BracketRight'],
  "'": [222, 'Quote']
}

type UsKeyboardKey = {
  keyCode: number
  code: string
  shift: boolean
}

function usKeyboardKeyForChar(ch: string): UsKeyboardKey | null {
  if (ch >= 'a' && ch <= 'z') {
    return { keyCode: ch.charCodeAt(0) - 32, code: `Key${ch.toUpperCase()}`, shift: false }
  }
  if (ch >= 'A' && ch <= 'Z') {
    return { keyCode: ch.charCodeAt(0), code: `Key${ch}`, shift: true }
  }
  if (ch >= '0' && ch <= '9') {
    return { keyCode: ch.charCodeAt(0), code: `Digit${ch}`, shift: false }
  }
  if (Object.hasOwn(US_SHIFTED_CHARS, ch)) {
    const base = usKeyboardKeyForChar(US_SHIFTED_CHARS[ch])
    return base === null ? null : { keyCode: base.keyCode, code: base.code, shift: true }
  }
  if (Object.hasOwn(US_PUNCTUATION_KEYS, ch)) {
    return { keyCode: US_PUNCTUATION_KEYS[ch][0], code: US_PUNCTUATION_KEYS[ch][1], shift: false }
  }
  return null
}

export type CdpKeyEvent = {
  keyCode: number
  key: string
  code: string
  modifiers: number
  // Why: null means the key produces no character (a rawKeyDown, not a keyDown with text).
  text: string | null
}

export function parseCdpKeyEvent(raw: string): CdpKeyEvent | null {
  if (raw.length === 0) {
    return null
  }
  let rest = raw
  let modifiers = 0
  while (rest.length > 1) {
    const plus = rest.indexOf('+')
    if (plus <= 0) {
      break
    }
    const name = rest.slice(0, plus).toLowerCase()
    if (!Object.hasOwn(CDP_MODIFIER_BITS, name)) {
      break
    }
    modifiers |= CDP_MODIFIER_BITS[name]
    rest = rest.slice(plus + 1)
  }
  if (rest.length === 0) {
    return null
  }

  let keyCode: number
  let key: string
  let code: string
  let text: string | null
  if (rest.length === 1) {
    const mapped = usKeyboardKeyForChar(rest)
    if (mapped === null) {
      return null
    }
    keyCode = mapped.keyCode
    key = rest
    code = mapped.code
    text = rest
    // Why: a capital letter in a shortcut is how people write the key, not a request for
    // shift — Ctrl+A means select-all (key 'a'), never Ctrl+Shift+A. Shifted punctuation
    // is different: on a US keyboard shift is the only way to produce the character.
    const capitalShortcut = rest >= 'A' && rest <= 'Z' && (modifiers & ~8) !== 0
    if (capitalShortcut) {
      key = rest.toLowerCase()
      text = key
    } else if (mapped.shift) {
      modifiers |= 8
    }
  } else if (Object.hasOwn(CDP_NAMED_KEYS, rest.toLowerCase())) {
    const named = CDP_NAMED_KEYS[rest.toLowerCase()]
    keyCode = named[0]
    key = named[1]
    code = named[2]
    text = named[3]
  } else {
    const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(rest)
    if (functionKey === null) {
      return null
    }
    keyCode = 111 + Number(functionKey[1])
    key = `F${functionKey[1]}`
    code = key
    text = null
  }

  if (text !== null && (modifiers & 8) !== 0) {
    text = Object.hasOwn(US_SHIFT_OF, text) ? US_SHIFT_OF[text] : text.toUpperCase()
    // Why: Shift+a is the "A" key as far as the page is concerned.
    if (rest.length === 1) {
      key = text
    }
  }
  // Why: with ctrl, alt or meta held the press is a shortcut and produces no character.
  if ((modifiers & ~8) !== 0) {
    text = null
  }

  return { keyCode, key, code, modifiers, text }
}
