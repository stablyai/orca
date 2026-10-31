/** Use an absolute epoch-ms deadline. Default failures return fallback; failClosedError rejects timeout/run failures for destructive callers, filtered by failClosedOnRunError. */
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
    // Defer run through then so synchronous throws pass the same fail-closed filter.
    void Promise.resolve()
      .then(run)
      .then(finish, (error: unknown) =>
        failClosedError && failClosedOnRunError(error) ? fail(error) : finish(fallback)
      )
  })
}
