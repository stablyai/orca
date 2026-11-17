/** The watch's verdict, or false as soon as the request is cancelled. */
export function untilAborted(
  watch: Promise<boolean>,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (!signal) {
    return watch
  }
  if (signal.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    void watch.then((ready) => {
      signal.removeEventListener('abort', onAbort)
      resolve(ready)
    })
  })
}
