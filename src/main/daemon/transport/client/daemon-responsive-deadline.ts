// Ticks short enough that a frozen stretch is credited at most this much.
const DEADLINE_TICK_MS = 250
// A tick later than its delay by more than this ran after a freeze.
const LATE_TICK_TOLERANCE_MS = 100

/** Expires after `timeoutMs` of responsive event-loop time; after a freeze, I/O that arrived meanwhile settles first. */
export function startResponsiveDeadline(
  timeoutMs: number,
  onExpire: () => void,
  options: { unref?: boolean } = {}
): () => void {
  let creditedMs = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  // Node runs due timers before I/O that completed during a freeze, so a late tick never expires;
  // the next tick is a full one so that backlog can drain before deciding.
  const arm = (afterFreeze: boolean): void => {
    const remainingMs = afterFreeze ? timeoutMs : timeoutMs - creditedMs
    const delayMs = Math.max(1, Math.min(DEADLINE_TICK_MS, remainingMs))
    const armedAt = performance.now()
    timer = setTimeout(() => {
      timer = null
      const late = performance.now() - armedAt > delayMs + LATE_TICK_TOLERANCE_MS
      creditedMs += delayMs
      if (late || creditedMs < timeoutMs) {
        arm(late)
        return
      }
      onExpire()
    }, delayMs)
    if (options.unref) {
      timer.unref()
    }
  }

  arm(false)
  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
