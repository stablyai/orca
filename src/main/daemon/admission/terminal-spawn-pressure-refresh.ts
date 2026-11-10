// A waiter that slept to its deadline must not be held past it by a slow pressure re-read.
const PRESSURE_REFRESH_BOUND_MS = 250

/** Waits for a fresh pressure reading, but never past cancellation or a short bound. */
export async function refreshPressureBounded(
  refresh: (() => Promise<void>) | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!refresh) {
    return
  }
  let release = (): void => {}
  const bound = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PRESSURE_REFRESH_BOUND_MS)
    timer.unref?.()
    signal?.addEventListener('abort', () => resolve(), { once: true })
    release = () => clearTimeout(timer)
  })
  try {
    await Promise.race([
      Promise.resolve()
        .then(refresh)
        .catch(() => {}),
      bound
    ])
  } finally {
    release()
  }
}
