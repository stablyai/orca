import type { InputEvent, KeyboardInputEvent } from 'electron'

type ElectronModifier = NonNullable<InputEvent['modifiers']>[number]

// Electron supports this untyped flag to keep unhandled keys out of Orca shortcuts and menus.
export type GuestKeyboardEvent = KeyboardInputEvent & { skipIfUnhandled: true }

export type GuestEditCommand = 'selectAll' | 'copy' | 'cut' | 'paste' | 'undo' | 'redo' | 'delete'

type GuestKeyPlan = {
  events: GuestKeyboardEvent[]
  // Widget events skip the browser bindings that execute macOS CDP edit commands.
  commands: GuestEditCommand[]
}

const CDP_MODIFIER_NAMES: [number, ElectronModifier][] = [
  [1, 'alt'],
  [2, 'control'],
  [4, 'meta'],
  [8, 'shift']
]

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
  // Electron derives key/code from the US layout, which covers printable ASCII.
  return key.length === 1 && key >= '!' && key <= '~' ? key : null
}

function electronModifiers(mask: unknown): ElectronModifier[] {
  const bits = typeof mask === 'number' ? mask : 0
  return CDP_MODIFIER_NAMES.filter(([bit]) => (bits & bit) !== 0).map(([, name]) => name)
}

// Blink drops control characters from char events; use the fallback to preserve them.
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
  // Named keys handle their own control text; Enter alone needs a char event for forms and newlines.
  const isNamedKey =
    typeof params.key === 'string' &&
    params.key !== ' ' &&
    Object.hasOwn(ELECTRON_KEY_CODES, params.key)
  if (type === 'keyDown' && !isNamedKey && typeof text === 'string' && text !== '') {
    if (!typeableText(text)) {
      return null
    }
    // Non-US characters can be typed by char event without an Electron key code.
    const down: GuestKeyboardEvent[] =
      keyCode === null ? [] : [{ type: 'keyDown', keyCode, modifiers, skipIfUnhandled: true }]
    return { events: [...down, ...charEvents(text, modifiers)], commands }
  }
  if (keyCode === null) {
    // Non-US char-only input has no pressed widget key to release; avoid borrowing focus.
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

export function planInsertText(text: unknown): GuestKeyboardEvent[] | null {
  return typeableText(text) ? charEvents(text, []) : null
}
