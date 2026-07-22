export function waitForSshCapabilityProbe<T>(probe: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return probe
  }
  if (signal.aborted) {
    return Promise.reject(new Error('client_disconnected'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('client_disconnected'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void probe.then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
