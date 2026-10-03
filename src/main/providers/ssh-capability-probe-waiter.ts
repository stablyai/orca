export function waitForSshCapabilityProbe<T>(probe: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return probe
  }
  if (signal.aborted) {
    return Promise.reject(new Error('client_disconnected'))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settlement: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      settlement()
    }
    const onAbort = (): void => {
      finish(() => reject(new Error('client_disconnected')))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void probe.then(
      (result) => {
        finish(() => resolve(result))
      },
      (error: unknown) => {
        finish(() => reject(error))
      }
    )
  })
}
