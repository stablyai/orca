// Ticks short enough that a frozen stretch is credited at most this much.
const DEADLINE_TICK_MS = 250
// A tick later than its delay by more than this ran after a freeze.
const LATE_TICK_TOLERANCE_MS = 100

/**
 * Runs `onExpire` once the event loop has been free to run for `timeoutMs`. A synchronous stall in
 * this process (a Windows CreateProcess that blocks for seconds) is credited only as one tick, and a
 * tick that ran late never expires the deadline itself: after a stall Node runs due timers before
 * the socket completions that arrived meanwhile, so a wall-clock timer would condemn a transport
 * that answered on time. Returns a cancel function.
 */
export function startResponsiveDeadline(
  timeoutMs: number,
  onExpire: () => void,
  // Wall clock, so fake timers drive it; a backward step credits nothing, a forward one a single tick.
  now: () => number = () => Date.now()
): () => void {
  let creditedMs = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let finished = false

  const arm = (): void => {
    const delayMs = Math.max(1, Math.min(DEADLINE_TICK_MS, timeoutMs - creditedMs))
    const armedAt = now()
    timer = setTimeout(() => {
      timer = null
      if (finished) {
        return
      }
      const elapsedMs = Math.max(0, now() - armedAt)
      const late = elapsedMs > delayMs + LATE_TICK_TOLERANCE_MS
      creditedMs += late ? delayMs : elapsedMs
      // After a freeze, let one I/O phase run before deciding.
      if (late || creditedMs < timeoutMs) {
        arm()
        return
      }
      finished = true
      onExpire()
    }, delayMs)
  }

  arm()
  return () => {
    finished = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
