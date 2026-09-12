export function rethrowCheckDetailsAbort(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) {
    throw error
  }
}

export function waitForCheckDetailsResolution<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}
