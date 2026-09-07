/**
 * Races `run()` against an absolute deadline (epoch ms).
 *
 * Without `failClosedError` the call is best-effort: a timeout or a rejection
 * resolves to `fallback`. With it, both surface as a rejection so destructive
 * callers can block on unproven work — `failClosedOnRunError` narrows which
 * rejections count (some are benign sentinels).
 */
export async function settleBeforeDeadline<T>(
  run: () => Promise<T>,
  fallback: T,
  deadline: number,
  failClosedError?: Error,
  failClosedOnRunError: (error: unknown) => boolean = () => true
): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    if (failClosedError) {
      throw failClosedError
    }
    return fallback
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: T): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(
      () => (failClosedError ? fail(failClosedError) : finish(fallback)),
      remaining
    )
    timer.unref?.()
    // Why: `.then(run)` rather than `run()` so a synchronous throw is routed
    // through the same fail-closed filter instead of escaping the executor.
    void Promise.resolve()
      .then(run)
      .then(finish, (error: unknown) =>
        failClosedError && failClosedOnRunError(error) ? fail(error) : finish(fallback)
      )
  })
}
