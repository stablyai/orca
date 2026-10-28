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

// Chromium needs clickCount 2 on the second press to emit dblclick.
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
  // An unqualified mouseUp must still release a held button after a chorded release.
  state.button = cdpPointerButtonFromMask(state.buttons)
}

export function resolveCdpPointerReleaseButton(state: CdpPointerState): string | undefined {
  return state.button === 'none' ? undefined : state.button
}
