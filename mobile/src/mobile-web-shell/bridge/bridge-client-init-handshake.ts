import { BRIDGE_PROTOCOL_VERSION, type BridgeClientMessage } from './bridge-envelope'
import { BRIDGE_BACK_FRAME } from './bridge-page-back'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import { BRIDGE_ROUTE_UPDATE_ACCEPT } from './bridge-route-update'
import { BRIDGE_SAFE_AREA_ACCEPT } from './bridge-safe-area-insets'
import { BRIDGE_KEYBOARD_INSET_ACCEPT } from './bridge-keyboard-inset'

/** The page asks again until the shell answers; a session has no other way to start. */
export const BRIDGE_READY_RETRY_MIN_MS = 50
export const BRIDGE_READY_RETRY_MAX_MS = 2000

export type BridgeInitHandshake = {
  /** Posts `ready` now, and again on a widening backoff until `stop`. */
  start: () => void
  stop: () => void
  /** For a shell rebuilt under the page: the wait starts over from the floor. */
  restart: () => void
}

/**
 * How the page gets a session.
 *
 * The shell posts `init` when it is ready, but a page that loaded first, or reloaded after the shell
 * had already sent one, would wait forever for a frame that has been and gone. Asking on a widening
 * backoff costs one frame at a time and needs nothing remembered on the shell's side.
 */
export function createBridgeInitHandshake(ask: () => void): BridgeInitHandshake {
  let timer: ReturnType<typeof setTimeout> | null = null
  let delayMs = BRIDGE_READY_RETRY_MIN_MS

  function start(): void {
    ask()
    timer = setTimeout(() => {
      delayMs = Math.min(delayMs * 2, BRIDGE_READY_RETRY_MAX_MS)
      start()
    }, delayMs)
  }

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    start,
    stop,
    restart: (): void => {
      stop()
      delayMs = BRIDGE_READY_RETRY_MIN_MS
      start()
    }
  }
}

/**
 * What the page says on every ask, because the shell reads it off whichever `ready` it answers.
 * `accepts` is what this page build can be sent: a second `init` for the session it holds, the
 * Back frame, insets it pads for itself, and the keyboard height it lifts by. `reports` runs the
 * other way: what a shell may wait for this page to post, and the shell holds a frame over the view
 * until it arrives.
 */
export function createPageReadyFrame(): Extract<BridgeClientMessage, { type: 'ready' }> {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'ready',
    accepts: [
      BRIDGE_ROUTE_UPDATE_ACCEPT,
      BRIDGE_BACK_FRAME,
      BRIDGE_SAFE_AREA_ACCEPT,
      BRIDGE_KEYBOARD_INSET_ACCEPT
    ],
    reports: [BRIDGE_PAGE_PAINTED]
  }
}
