import type { InputEvent, KeyboardInputEvent } from 'electron'

/** Translates CDP key and text input into Electron guest widget events (#20595). */

type ElectronModifier = NonNullable<InputEvent['modifiers']>[number]

// Why: Electron honours this NativeWebKeyboardEvent flag although its typings omit it; an
// unhandled agent key must not be redispatched to Orca's window or application menu.
export type GuestKeyboardEvent = KeyboardInputEvent & { skipIfUnhandled: true }

export type GuestEditCommand = 'selectAll' | 'copy' | 'cut' | 'paste' | 'undo' | 'redo' | 'delete'

type GuestKeyPlan = {
  events: GuestKeyboardEvent[]
  // Why: macOS editing shortcuts arrive as CDP `commands`; widget key events skip the
  // browser-side key bindings that would run them.
  commands: GuestEditCommand[]
}

const CDP_MODIFIER_NAMES: [number, ElectronModifier][] = [
  [1, 'alt'],
  [2, 'control'],
  [4, 'meta'],
  [8, 'shift']
]

// CDP `key` -> Electron accelerator key code, for keys whose names differ or are not single characters.
const ELECTRON_KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  CapsLock: 'CapsLock',
  NumLock: 'NumLock',
  ScrollLock: 'ScrollLock',
  PrintScreen: 'PrintScreen',
  Shift: 'Shift',
  Control: 'Control',
  Alt: 'Alt',
  Meta: 'Meta'
}

const GUEST_EDIT_COMMANDS: ReadonlySet<string> = new Set<GuestEditCommand>([
  'selectAll',
  'copy',
  'cut',
  'paste',
  'undo',
  'redo',
  'delete'
])

function isGuestEditCommand(command: unknown): command is GuestEditCommand {
  return typeof command === 'string' && GUEST_EDIT_COMMANDS.has(command)
}

function electronKeyCode(key: unknown): string | null {
  if (typeof key !== 'string') {
    return null
  }
  if (Object.hasOwn(ELECTRON_KEY_CODES, key)) {
    return ELECTRON_KEY_CODES[key]
  }
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) {
    return key
  }
  // Why: Electron derives key/code from a US layout, which covers printable ASCII only.
  return key.length === 1 && key >= '!' && key <= '~' ? key : null
}

function electronModifiers(mask: unknown): ElectronModifier[] {
  const bits = typeof mask === 'number' ? mask : 0
  return CDP_MODIFIER_NAMES.filter(([bit]) => (bits & bit) !== 0).map(([, name]) => name)
}

// Why: Blink drops control characters from char events ("a\nb" types "ab"), so text that
// carries them cannot be typed this way and must take the fallback.
function typeableText(text: unknown): text is string {
  return (
    typeof text === 'string' &&
    text.length > 0 &&
    Array.from(text).every((char) => {
      const code = char.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
  )
}

function charEvents(text: string, modifiers: ElectronModifier[]): GuestKeyboardEvent[] {
  return Array.from(text, (char) => ({
    type: 'char',
    keyCode: char,
    modifiers,
    skipIfUnhandled: true
  }))
}

/** Translates one CDP Input.dispatchKeyEvent into guest widget events, or null when it cannot. */
export function planCdpKeyEvent(params: Record<string, unknown>): GuestKeyPlan | null {
  const commandsParam = params.commands ?? []
  if (!Array.isArray(commandsParam) || !commandsParam.every(isGuestEditCommand)) {
    return null
  }
  const commands = commandsParam
  const modifiers = electronModifiers(params.modifiers)
  const { type, text } = params
  if (type === 'char') {
    return typeableText(text) ? { events: charEvents(text, modifiers), commands } : null
  }
  if (type !== 'keyDown' && type !== 'rawKeyDown' && type !== 'keyUp') {
    return null
  }
  const keyCode = electronKeyCode(params.key)
  // Why: a named key's text is a control character (Tab "\t", Backspace "\b") that the key
  // event already acts on; only Enter's "\r" char is needed, to submit forms and insert newlines.
  const isNamedKey =
    typeof params.key === 'string' &&
    params.key !== ' ' &&
    Object.hasOwn(ELECTRON_KEY_CODES, params.key)
  if (type === 'keyDown' && !isNamedKey && typeof text === 'string' && text !== '') {
    if (!typeableText(text)) {
      return null
    }
    // Why: a non-US-layout character has no Electron key code; the char event alone types it.
    const down: GuestKeyboardEvent[] =
      keyCode === null ? [] : [{ type: 'keyDown', keyCode, modifiers, skipIfUnhandled: true }]
    return { events: [...down, ...charEvents(text, modifiers)], commands }
  }
  if (keyCode === null) {
    // Why: a character outside the US layout went down as a char event alone; its keyUp has no
    // widget form, and the fallback would focus the guest just to release a key never pressed.
    const isCharacterKey = typeof params.key === 'string' && Array.from(params.key).length === 1
    return type === 'keyUp' && isCharacterKey ? { events: [], commands } : null
  }
  const event: GuestKeyboardEvent = {
    type: type === 'keyUp' ? 'keyUp' : 'keyDown',
    keyCode,
    modifiers,
    skipIfUnhandled: true
  }
  const enterChar: GuestKeyboardEvent[] =
    type === 'keyDown' && params.key === 'Enter' && (text === '\r' || text === '\n')
      ? [{ type: 'char', keyCode: '\r', modifiers, skipIfUnhandled: true }]
      : []
  return { events: [event, ...enterChar], commands }
}

/** Translates CDP Input.insertText into guest widget char events, or null when it cannot. */
export function planInsertText(text: unknown): GuestKeyboardEvent[] | null {
  return typeableText(text) ? charEvents(text, []) : null
}
