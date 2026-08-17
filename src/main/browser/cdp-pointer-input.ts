import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import type { ElectronDebuggerLease } from './electron-debugger-lease'

// Why: restores await-the-renderer-ack for debugging — see dispatchCdpPointerEvent.
function awaitPointerAck(): boolean {
  return process.env.ORCA_BROWSER_INPUT_AWAIT_ACK === '1'
}

const MULTI_CLICK_INTERVAL_MS = 500
const MULTI_CLICK_SLOP_PX = 2

export type CdpPointerButton = 'left' | 'middle' | 'right' | 'back' | 'forward'

// Why: unlike element clicks, coordinate down/up must carry X1/X2 buttons through — the
// helper dispatched them as real back/forward presses, and coercing them to left would
// click whatever sits under the pointer.
export function normalizeCdpPointerButton(button?: string): CdpPointerButton {
  return button === 'middle' || button === 'right' || button === 'back' || button === 'forward'
    ? button
    : 'left'
}

export function cdpPointerButtonMask(button: CdpPointerButton): number {
  if (button === 'right') {
    return 2
  }
  if (button === 'middle') {
    return 4
  }
  if (button === 'back') {
    return 8
  }
  if (button === 'forward') {
    return 16
  }
  return 1
}

type LastPointerClick = {
  button: CdpPointerButton
  x: number
  y: number
  at: number
  count: number
}

export type CdpPointerState = {
  x: number
  y: number
  button: 'none' | CdpPointerButton
  buttons: number
  clickCount: number
  lastClick: LastPointerClick | null
  pending: Promise<void> | null
  lastError: string | null
}

// Why: keyed by the WebContents itself so per-tab pointer state can never leak across
// tabs and dies with the tab instead of needing teardown hooks.
const pointerStates = new WeakMap<WebContents, CdpPointerState>()

export function cdpPointerStateFor(webContents: WebContents): CdpPointerState {
  let state = pointerStates.get(webContents)
  if (!state) {
    state = {
      x: 0,
      y: 0,
      button: 'none',
      buttons: 0,
      clickCount: 1,
      lastClick: null,
      pending: null,
      lastError: null
    }
    pointerStates.set(webContents, state)
  }
  return state
}

// Why: a second press at the same spot inside the double-click interval must report the
// next clickCount or Chromium never fires dblclick. Cycles 1, 2, 3, 1 like a real mouse.
export function trackCdpClickCount(state: CdpPointerState, button: CdpPointerButton): number {
  const now = Date.now()
  const previous = state.lastClick
  const repeated =
    previous !== null &&
    previous.button === button &&
    Math.abs(previous.x - state.x) <= MULTI_CLICK_SLOP_PX &&
    Math.abs(previous.y - state.y) <= MULTI_CLICK_SLOP_PX &&
    now - previous.at <= MULTI_CLICK_INTERVAL_MS
  const count = repeated ? (previous.count >= 3 ? 1 : previous.count + 1) : 1
  state.lastClick = { button, x: state.x, y: state.y, at: now, count }
  return count
}

// Why: an un-awaited dispatch would report success and park Chromium's invalid-params
// error on a later event; reject non-finite coordinates and deltas up front instead.
export function assertFinitePointerValues(values: Record<string, number>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) {
      throw new BrowserError('browser_error', `Pointer input requires a finite ${name}`)
    }
  }
}

export type CdpPointerEventParams = {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button?: string
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
}

// Why: awaiting sendCommand awaits the renderer's frame-bound ack — ~16ms on a watched
// tab, ~1s on an unwatched one, which also spaces clicks too far apart for dblclick. The
// event is dispatched in order regardless, so we return once it is written and surface a
// late failure on the caller's next pointer event instead of swallowing it.
export function dispatchCdpPointerEvent(
  state: CdpPointerState,
  webContents: WebContents,
  params: CdpPointerEventParams
): Promise<void> {
  const failure = state.lastError
  if (failure !== null) {
    state.lastError = null
    throw new BrowserError('browser_error', `The previous pointer event failed: ${failure}`)
  }
  const sent = webContents.debugger.sendCommand('Input.dispatchMouseEvent', params)
  if (awaitPointerAck()) {
    return sent.then(() => undefined)
  }
  state.pending = sent.then(
    () => undefined,
    (error: unknown) => {
      state.lastError = error instanceof Error ? error.message : String(error)
    }
  )
  return Promise.resolve()
}

// Why: releasing the debugger lease before an un-awaited dispatch settles could detach
// the debugger out from under the in-flight event.
export function releaseLeaseAfterPointerDispatch(
  state: CdpPointerState,
  lease: ElectronDebuggerLease
): void {
  const pending = state.pending
  state.pending = null
  if (pending) {
    void pending.then(
      () => lease.release(),
      () => lease.release()
    )
    return
  }
  lease.release()
}
