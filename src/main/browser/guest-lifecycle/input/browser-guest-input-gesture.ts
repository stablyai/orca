import type { WebContents } from 'electron'
import { isAgentInjectingInput } from '../../cdp/input/agent-input-injection'

// Window-open details lack user activation; track browser-process input instead of page events.
const ACTIVATING_MOUSE_TYPES: ReadonlySet<string> = new Set(['mouseDown', 'mouseUp'])
const ACTIVATING_OTHER_INPUT_TYPES: ReadonlySet<string> = new Set([
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

/** Calls `listener` for each click in any of the page's frames, and each key press or tap in its main frame. */
export function onActivatingBrowserGuestInput(
  contents: WebContents,
  listener: () => void
): () => void {
  // Why: input-event only sees the main frame's widget, so clicks in out-of-process (cross-site
  // or sandboxed) frames reach before-mouse-event alone.
  const onMouse = (_event: Electron.Event, mouse: Electron.MouseInputEvent): void => {
    if (ACTIVATING_MOUSE_TYPES.has(mouse.type)) {
      listener()
    }
  }
  const onInput = (_event: Electron.Event, input: Electron.InputEvent): void => {
    if (ACTIVATING_OTHER_INPUT_TYPES.has(input.type)) {
      listener()
    }
  }
  contents.on('before-mouse-event', onMouse)
  contents.on('input-event', onInput)
  return () => {
    try {
      contents.off('before-mouse-event', onMouse)
      contents.off('input-event', onInput)
    } catch {
      // Contents may already be destroyed.
    }
  }
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
  onActivatingBrowserGuestInput(contents, () =>
    noteSessionInput(contents, Date.now(), isAgentInjectingInput(contents))
  )
}

/** The latest activating input any guest in `session` received, and who sent it. */
export function getLastBrowserGuestInputInSession(
  session: Electron.Session
): LastBrowserGuestInput | null {
  return lastInputBySession.get(session) ?? null
}

/** A recent activating input; `byAgent` when an agent or remote viewer sent it, not this desktop's user. */
export type ObservedBrowserGuestGesture = {
  byAgent: boolean
  /** Its sender works with this desktop's windows: the user, or an agent's command on a page shown here, not a paired viewer. */
  fromThisDesktop: boolean
}

const gestureForgetters = new WeakMap<WebContents, Set<() => void>>()

/** A DOM-activated tap fires no guest input event; drop earlier input so the tap cannot inherit its sender. */
export function forgetBrowserGuestInputGestures(guest: WebContents): void {
  for (const forget of gestureForgetters.get(guest) ?? []) {
    forget()
  }
}

export type BrowserGuestInputGesture = {
  /** Single-use: one observed click cannot be replayed into a second window or tab. */
  consume: () => ObservedBrowserGuestGesture | null
  dispose: () => void
}

export function trackBrowserGuestInputGesture(
  guest: WebContents,
  {
    now = Date.now,
    onActivatingInput,
    isAgentCommandShownHere
  }: {
    now?: () => number
    onActivatingInput?: (byAgent: boolean) => void
    /** An agent's command, not a paired viewer's relayed input, is driving this page, and this desktop shows it. */
    isAgentCommandShownHere?: (guestWebContentsId: number) => boolean
  } = {}
): BrowserGuestInputGesture {
  let lastGestureAt: number | null = null
  let lastGestureByAgent = false
  let lastGestureFromThisDesktop = false
  let unsubscribe: (() => void) | null = null
  const forget = (): void => {
    lastGestureAt = null
  }
  const forgetters = gestureForgetters.get(guest) ?? new Set<() => void>()
  forgetters.add(forget)
  gestureForgetters.set(guest, forgetters)
  try {
    unsubscribe = onActivatingBrowserGuestInput(guest, () => {
      lastGestureAt = now()
      lastGestureByAgent = isAgentInjectingInput(guest)
      lastGestureFromThisDesktop =
        !lastGestureByAgent || isAgentCommandShownHere?.(guest.id) === true
      noteSessionInput(guest, lastGestureAt, lastGestureByAgent)
      onActivatingInput?.(lastGestureByAgent)
    })
  } catch {
    // Fail closed: an unobservable input stream never counts as a gesture.
  }
  return {
    consume: () => {
      const observedAt = lastGestureAt
      lastGestureAt = null
      return unsubscribe && observedAt !== null && isRecentBrowserGuestInput(observedAt, now())
        ? { byAgent: lastGestureByAgent, fromThisDesktop: lastGestureFromThisDesktop }
        : null
    },
    dispose: () => {
      lastGestureAt = null
      forgetters.delete(forget)
      unsubscribe?.()
      unsubscribe = null
    }
  }
}
