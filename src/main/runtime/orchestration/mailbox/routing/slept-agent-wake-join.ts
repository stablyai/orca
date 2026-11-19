/** One caller's share of a shared wake, bounded by that caller's own abort and deadline. */
export function joinWithin(
  woken: Promise<void>,
  bounds: { signal?: AbortSignal; timeoutMs?: number }
): Promise<void> {
  const { signal, timeoutMs } = bounds
  if (!signal && !(timeoutMs && timeoutMs > 0)) {
    return woken
  }
  return new Promise((resolve, reject) => {
    const settle = (error?: unknown): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    }
    const onAbort = (): void => settle(signal?.reason ?? new Error('request_aborted'))
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => settle(new Error('timeout')), timeoutMs)
        : undefined
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    woken.then(() => settle(), settle)
  })
}
