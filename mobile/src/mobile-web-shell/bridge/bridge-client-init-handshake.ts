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
