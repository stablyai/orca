// Character codes for '&' and '.' collide with VK_UP/VK_DELETE; use US virtual key codes.

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

// char -> [windowsVirtualKeyCode, code]
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
  // 1 denotes the left-side modifiers used by the table.
  location: number
  // A modifier's own bit is set on keydown and cleared on keyup.
  selfModifier: number
  // Null requires rawKeyDown, without character text.
  text: string | null
}

// Use IME keyCode 229 for single BMP characters; pairs and sequences retain helper behavior.
export function imeFallbackKeyEvent(raw: string): CdpKeyEvent | null {
  if (raw.length !== 1) {
    return null
  }
  const codePoint = raw.charCodeAt(0)
  if (codePoint < 0xa0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return null
  }
  return { keyCode: 229, key: raw, code: '', modifiers: 0, location: 0, selfModifier: 0, text: raw }
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
  let location = 0
  let selfModifier = 0
  if (rest.length === 1) {
    const mapped = usKeyboardKeyForChar(rest)
    if (mapped === null) {
      return null
    }
    keyCode = mapped.keyCode
    key = rest
    code = mapped.code
    text = rest
    // Ctrl+A denotes a lowercase key without Shift; shifted punctuation still needs Shift.
    const capitalShortcut = rest >= 'A' && rest <= 'Z' && (modifiers & ~8) !== 0
    if (capitalShortcut) {
      key = rest.toLowerCase()
      text = key
    } else if (mapped.shift) {
      modifiers |= 8
    }
  } else if (Object.hasOwn(CDP_NAMED_KEYS, rest.toLowerCase())) {
    const name = rest.toLowerCase()
    const named = CDP_NAMED_KEYS[name]
    keyCode = named[0]
    key = named[1]
    code = named[2]
    text = named[3]
    // Blink includes a modifier's own bit on keydown; the table uses left-side keys.
    selfModifier = CDP_MODIFIER_BITS[name] ?? 0
    if (selfModifier !== 0) {
      modifiers |= selfModifier
      location = 1
    }
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
    if (rest.length === 1) {
      key = text
    }
  }
  // Ctrl, Alt, and Meta shortcuts produce no character text.
  if ((modifiers & ~8) !== 0) {
    text = null
  }

  return { keyCode, key, code, modifiers, location, selfModifier, text }
}

/** The key a person presses to type one character, or null when no key types it. */
function typedCharacterKeyEvent(char: string): CdpKeyEvent | null {
  if (char === '\n') {
    return parseCdpKeyEvent('Enter')
  }
  if (char === '\t') {
    return parseCdpKeyEvent('Tab')
  }
  return parseCdpKeyEvent(char) ?? imeFallbackKeyEvent(char)
}

const MAX_UNTYPABLE_RUN_LENGTH = 512

/** A key to press, or a run of text that no key types. */
export type TypedInputStep = CdpKeyEvent | string

/** The keys that type `input`, yielded lazily so long text is never held as events. */
export function* typedInputSteps(input: string): Generator<TypedInputStep> {
  let untypable = ''
  for (const char of input.replace(/\r\n?/g, '\n')) {
    const key = typedCharacterKeyEvent(char)
    if (!key) {
      untypable += char
      // Bounded like key runs, since a widget page receives this text one event per character.
      if (untypable.length >= MAX_UNTYPABLE_RUN_LENGTH) {
        yield untypable
        untypable = ''
      }
      continue
    }
    if (untypable) {
      yield untypable
      untypable = ''
    }
    yield key
  }
  if (untypable) {
    yield untypable
  }
}
