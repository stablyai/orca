import type { InputEvent, KeyboardInputEvent, WebContents } from 'electron'
import { enablePageFocusEmulation, type AgentInputFocusGuard } from './agent-input-focus-guard'
import { withAgentInputInjection } from './agent-input-injection'
import {
  resolveFocusedFrameRoute,
  settleWithin,
  type GuestSessionCdpSender
} from './guest-focused-frame-route'
import { sendFrameSessionInput } from './guest-frame-input-sessions'

// Why: Chromium routes main-session CDP key and text input on a <webview> guest by the
// window's focus, so it lands in whatever the user is typing into (#20595). Events sent to
// the guest's own widget reach its page without moving focus.
// See docs/reference/agent-browser-focus-isolation.md.

type ElectronModifier = NonNullable<InputEvent['modifiers']>[number]

// Why: Electron honours this NativeWebKeyboardEvent flag although its typings omit it; an
// unhandled agent key must not be redispatched to Orca's window or application menu.
type GuestKeyboardEvent = KeyboardInputEvent & { skipIfUnhandled: true }

type GuestEditCommand = 'selectAll' | 'copy' | 'cut' | 'paste' | 'undo' | 'redo' | 'delete'

type GuestKeyPlan = {
  events: GuestKeyboardEvent[]
  // Why: macOS editing shortcuts arrive as CDP `commands`; widget key events skip the
  // browser-side key bindings that would run them.
  commands: GuestEditCommand[]
}

export type GuestCdpSender = GuestSessionCdpSender

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

// Why: getType() is 'webview' only for guests hosted in an Orca window; offscreen and
// headless pages have no host frame tree, so CDP input already reaches them.
export function isEmbeddedGuest(webContents: WebContents): boolean {
  return webContents.getType() === 'webview'
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

// Why: sendInputEvent returns before the page handles the event, but CDP input replies only after.
// A task-queue round trip in the page lets callers read the result of what they just typed.
async function waitForPageToHandleInput(send: GuestCdpSender): Promise<void> {
  await settleWithin(
    send('Runtime.evaluate', {
      // Why: a message-channel task, not setTimeout, which hidden pages throttle to once a second.
      expression:
        'new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0) })',
      awaitPromise: true
    }),
    null
  )
}

function runEditCommand(webContents: WebContents, command: GuestEditCommand): void {
  switch (command) {
    case 'selectAll':
      webContents.selectAll()
      return
    case 'copy':
      webContents.copy()
      return
    case 'cut':
      webContents.cut()
      return
    case 'paste':
      webContents.paste()
      return
    case 'undo':
      webContents.undo()
      return
    case 'redo':
      webContents.redo()
      return
    case 'delete':
      webContents.delete()
  }
}

const NO_FOCUS_GUARD: AgentInputFocusGuard = async () => () => {}

// Why: the fallback needs the guest natively focused for CDP to reach it; the guard hands the
// user's focus back afterwards, and emulation keeps the page from seeing that as a blur.
async function focusGuestForCdpInput(
  webContents: WebContents,
  send: GuestCdpSender,
  guardFocus: AgentInputFocusGuard
): Promise<() => void> {
  await enablePageFocusEmulation(send)
  const release = await guardFocus()
  webContents.focus()
  return release
}

// Why: CDP input on a cross-site frame's own session reaches that frame without the user's focus.
async function sendToFrameSession(
  webContents: WebContents,
  send: GuestCdpSender,
  sessionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return await withAgentInputInjection(webContents, () =>
    sendFrameSessionInput(webContents, send, sessionId, method, params)
  )
}

/**
 * Delivers a CDP key event to a page. Embedded guests get widget events, or CDP on a focused
 * cross-site frame's own session; anything else keeps the CDP path while borrowing focus.
 */
export async function dispatchPageKeyEvent(
  webContents: WebContents,
  params: Record<string, unknown>,
  send: GuestCdpSender,
  guardFocus: AgentInputFocusGuard = NO_FOCUS_GUARD
): Promise<unknown> {
  if (!isEmbeddedGuest(webContents)) {
    return await send('Input.dispatchKeyEvent', params)
  }
  const route = await resolveFocusedFrameRoute(webContents, send)
  if (route.kind === 'session') {
    // Why: Tab from a frame's last field can move focus out of the guest into Orca's window.
    const isTabDown =
      params.key === 'Tab' && (params.type === 'keyDown' || params.type === 'rawKeyDown')
    const release = isTabDown ? await guardFocus() : () => {}
    try {
      return await sendToFrameSession(
        webContents,
        send,
        route.sessionId,
        'Input.dispatchKeyEvent',
        params
      )
    } finally {
      release()
    }
  }
  const plan = planCdpKeyEvent(params)
  if (plan && route.kind === 'widget') {
    // Why: Tab from the page's last field moves focus out of the guest into Orca's window.
    const release = plan.events.some((event) => event.type === 'keyDown' && event.keyCode === 'Tab')
      ? await guardFocus()
      : () => {}
    try {
      await withAgentInputInjection(webContents, async () => {
        for (const event of plan.events) {
          webContents.sendInputEvent(event)
        }
        if (plan.commands.length > 0 || plan.events.length > 0) {
          await waitForPageToHandleInput(send)
        }
        for (const command of plan.commands) {
          runEditCommand(webContents, command)
        }
      })
    } finally {
      release()
    }
    return {}
  }
  const release = await focusGuestForCdpInput(webContents, send, guardFocus)
  try {
    return await withAgentInputInjection(webContents, () => send('Input.dispatchKeyEvent', params))
  } finally {
    release()
  }
}

export type TextInsertionRoute = {
  deliver: (params: Record<string, unknown>) => Promise<unknown>
  // Why: the fallback holds borrowed focus from routing until delivery; an insert abandoned in
  // between must still give it back.
  release: () => void
}

/**
 * Chooses how Input.insertText reaches a page: guest widget events for embedded guests, else
 * CDP with the guest focused. Call before any DOM.focus replay; the fallback's focus blurs.
 */
export async function routePageTextInsertion(
  webContents: WebContents,
  params: Record<string, unknown>,
  send: GuestCdpSender,
  guardFocus: AgentInputFocusGuard = NO_FOCUS_GUARD
): Promise<TextInsertionRoute> {
  const sendText = (insertParams: Record<string, unknown>): Promise<unknown> =>
    send('Input.insertText', insertParams)
  if (!isEmbeddedGuest(webContents)) {
    webContents.focus()
    return { deliver: sendText, release: () => {} }
  }
  const route = await resolveFocusedFrameRoute(webContents, send)
  if (route.kind === 'session') {
    const { sessionId } = route
    return {
      deliver: (insertParams) =>
        sendToFrameSession(webContents, send, sessionId, 'Input.insertText', insertParams),
      release: () => {}
    }
  }
  const events = planInsertText(params.text)
  if (events && route.kind === 'widget') {
    return {
      deliver: () =>
        withAgentInputInjection(webContents, async () => {
          for (const event of events) {
            webContents.sendInputEvent(event)
          }
          await waitForPageToHandleInput(send)
          return {}
        }),
      release: () => {}
    }
  }
  const release = await focusGuestForCdpInput(webContents, send, guardFocus)
  return {
    deliver: (insertParams) => withAgentInputInjection(webContents, () => sendText(insertParams)),
    release
  }
}
