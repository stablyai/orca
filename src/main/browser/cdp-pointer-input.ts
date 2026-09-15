import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import {
  type CdpPointerButton,
  cdpPointerButtonMask,
  cdpPointerButtonFromMask
} from './agent-browser-bridge-mouse'

const MULTI_CLICK_INTERVAL_MS = 500

const MULTI_CLICK_SLOP_PX = 2

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
  button: CdpPointerButton | 'none'
  buttons: number
  clickCount: number
  lastClick: LastPointerClick | null
}

// Why: keyed by the WebContents so per-tab pointer state can never leak across tabs and
// dies with the tab instead of needing teardown hooks.
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
      lastClick: null
    }
    pointerStates.set(webContents, state)
  }

  return state
}

// Why: Chromium only fires dblclick when the second press reports clickCount 2, so a
// repeat at the same spot inside the interval escalates. Cycles 1, 2, 3, 1 like a real mouse.
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

// Why: the helper rejected a non-finite coordinate outright and silently coerced a
// non-finite wheel delta to 100; CDP would reject with an invalid-params error naming no
// argument. Reject both here so the caller learns which value was bad.
export function assertFinitePointerValues(values: Record<string, number>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) {
      throw new BrowserError('browser_error', `Pointer input requires a finite ${name}`)
    }
  }
}

export function pressCdpPointerButton(state: CdpPointerState, button: CdpPointerButton): void {
  state.button = button
  state.buttons |= cdpPointerButtonMask(button)
  state.clickCount = trackCdpClickCount(state, button)
}

export function releaseCdpPointerButton(state: CdpPointerState, button: CdpPointerButton): void {
  state.buttons &= ~cdpPointerButtonMask(button)
  // Why: a chorded release leaves the still-held button addressable by a later
  // unqualified mouseUp instead of falling back to left.
  state.button = cdpPointerButtonFromMask(state.buttons)
}

// Why: the helper always released left, so a right-button press stayed stuck forever.
export function resolveCdpPointerReleaseButton(state: CdpPointerState): string | undefined {
  return state.button === 'none' ? undefined : state.button
}
