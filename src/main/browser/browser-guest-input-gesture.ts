import type { WebContents } from 'electron'

// Why: Electron's window-open details carry no user-activation flag, so main keeps its own
// browser-process input timeline instead of trusting anything the page can synthesize.
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

export type BrowserGuestInputGesture = {
  /** Single-use: one observed click cannot be replayed into a second window or tab. */
  consume: () => boolean
  dispose: () => void
}

export function trackBrowserGuestInputGesture(
  guest: WebContents,
  now: () => number = () => Date.now()
): BrowserGuestInputGesture {
  let lastGestureAt: number | null = null
  const onInputEvent = (_event: Electron.Event, input: Electron.InputEvent): void => {
    if (typeof input?.type === 'string' && ACTIVATING_INPUT_TYPES.has(input.type)) {
      lastGestureAt = now()
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
      return (
        attached &&
        observedAt !== null &&
        now() - observedAt <= BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS
      )
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
