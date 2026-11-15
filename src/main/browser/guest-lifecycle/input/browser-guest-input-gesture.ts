import type { WebContents } from 'electron'
import { isAgentInjectingInput } from '../../cdp/input/agent-input-injection'

// Window-open details lack user activation; track browser-process input instead of page events.
const ACTIVATING_INPUT_TYPES: ReadonlySet<string> = new Set([
  'mouseDown',
  'mouseUp',
  'keyDown',
  'rawKeyDown',
  'char',
  'touchStart',
  'touchEnd',
  'gestureTap',
  'pointerDown',
  'pointerUp'
])

export const BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS = 1_000

/** Whether activation observed at `observedAt` still lets the page act on it. */
export function isRecentBrowserGuestInput(observedAt: number, now: number): boolean {
  const elapsed = now - observedAt
  return elapsed >= 0 && elapsed <= BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS
}

export function isActivatingBrowserGuestInput(input: Electron.InputEvent | undefined): boolean {
  return typeof input?.type === 'string' && ACTIVATING_INPUT_TYPES.has(input.type)
}

export type LastBrowserGuestInput = { at: number; byAgent: boolean; guestWebContentsId: number }

// Why per session: an extension reacts to its profile's pages without knowing which input set it off.
const lastInputBySession = new WeakMap<Electron.Session, LastBrowserGuestInput>()

function noteSessionInput(contents: WebContents, at: number, byAgent: boolean): void {
  if (contents.session) {
    lastInputBySession.set(contents.session, { at, byAgent, guestWebContentsId: contents.id })
  }
}

/** For windows with no guest policies (extension popups and popouts): their clicks count for the session too. */
export function recordBrowserSessionInput(contents: WebContents): void {
  contents.on('input-event', (_event, input) => {
    if (isActivatingBrowserGuestInput(input)) {
      noteSessionInput(contents, Date.now(), isAgentInjectingInput(contents))
    }
  })
}

/** The latest activating input any guest in `session` received, and who sent it. */
export function getLastBrowserGuestInputInSession(
  session: Electron.Session
): LastBrowserGuestInput | null {
  return lastInputBySession.get(session) ?? null
}

/** A recent activating input; `byAgent` when an agent or remote viewer sent it, not this desktop's user. */
export type ObservedBrowserGuestGesture = { byAgent: boolean }

export type BrowserGuestInputGesture = {
  /** Single-use: one observed click cannot be replayed into a second window or tab. */
  consume: () => ObservedBrowserGuestGesture | null
  dispose: () => void
}

export function trackBrowserGuestInputGesture(
  guest: WebContents,
  {
    now = Date.now,
    onActivatingInput
  }: { now?: () => number; onActivatingInput?: (byAgent: boolean) => void } = {}
): BrowserGuestInputGesture {
  let lastGestureAt: number | null = null
  let lastGestureByAgent = false
  const onInputEvent = (_event: Electron.Event, input: Electron.InputEvent): void => {
    if (isActivatingBrowserGuestInput(input)) {
      lastGestureAt = now()
      lastGestureByAgent = isAgentInjectingInput(guest)
      noteSessionInput(guest, lastGestureAt, lastGestureByAgent)
      onActivatingInput?.(lastGestureByAgent)
    }
  }
  let attached = false
  try {
    guest.on('input-event', onInputEvent)
    attached = true
  } catch {
    // Fail closed: an unobservable input stream never counts as a gesture.
  }
  return {
    consume: () => {
      const observedAt = lastGestureAt
      lastGestureAt = null
      return attached && observedAt !== null && isRecentBrowserGuestInput(observedAt, now())
        ? { byAgent: lastGestureByAgent }
        : null
    },
    dispose: () => {
      lastGestureAt = null
      if (!attached) {
        return
      }
      attached = false
      try {
        guest.off('input-event', onInputEvent)
      } catch {}
    }
  }
}
