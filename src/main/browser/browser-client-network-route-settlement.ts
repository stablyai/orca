/** Deferred settled when the registry's last route retires; consumers await it via retire(). */
export function createRouteRetirement(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve = (): void => {}
  let reject = (_error: unknown): void => {}
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** Awaits route work under the caller's abort signal, rejecting the moment it fires. */
export function waitForRoute<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('browser_client_network_route_aborted'))
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('browser_client_network_route_aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
