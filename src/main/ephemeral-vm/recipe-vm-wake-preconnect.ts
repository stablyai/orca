// Pre-connect during a VM wake: the server's endpoint is known from the saved pairing before the
// resume answers, so the control socket keeps dialing on a short cadence while the VM boots and
// connects the moment the server listens, instead of starting its first dial after the resume
// call returns. Retries reuse the socket's own scheduled reconnect (no parallel dials).

export const PRECONNECT_RETRY_MS = 300
export const PRECONNECT_MAX_MS = 60_000

export type WakePreconnectDeps = {
  /** Creates (or keeps) the control socket for the saved pairing. */
  ensure: () => void
  isReady: () => boolean
  /** Advances the socket's scheduled reconnect now; never opens a second socket. */
  retryNow: () => void
  /** False once the wake ended (settled or abandoned). */
  isWaking: () => boolean
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** Starts pre-connecting; returns a stop function. Stops on its own once ready, done or timed out. */
export function startWakePreconnect(deps: WakePreconnectDeps): () => void {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const startedAt = now()
  let timer: unknown = null
  let stopped = false
  const stop = (): void => {
    stopped = true
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }
  const tick = (): void => {
    timer = null
    if (stopped) {
      return
    }
    if (deps.isReady() || !deps.isWaking() || now() - startedAt >= PRECONNECT_MAX_MS) {
      stop()
      return
    }
    try {
      deps.retryNow()
    } catch {
      // A transient failure of one nudge must not end the pre-connect.
    }
    timer = setTimer(tick, PRECONNECT_RETRY_MS)
  }
  try {
    deps.ensure()
  } catch {
    stop()
    return stop
  }
  timer = setTimer(tick, PRECONNECT_RETRY_MS)
  return stop
}

/**
 * Resolves true once the control socket is ready on a connection made after `since` (it then
 * authenticated with the saved token against the woken server), false on timeout. Lets the wake
 * treat that socket's own handshake as the proof of a kept pairing instead of a separate probe.
 */
export function waitForControlReadySince(deps: {
  lastReadyAt: () => number | null
  since: number
  timeoutMs: number
  pollMs?: number
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
}): Promise<boolean> {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const pollMs = deps.pollMs ?? 50
  const deadline = now() + deps.timeoutMs
  return new Promise((resolve) => {
    const check = (): void => {
      const readyAt = deps.lastReadyAt()
      if (readyAt !== null && readyAt >= deps.since) {
        resolve(true)
        return
      }
      if (now() >= deadline) {
        resolve(false)
        return
      }
      setTimer(check, pollMs)
    }
    check()
  })
}
