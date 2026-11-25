export function createCheckDetailsAbortError(): Error {
  const error = new Error('Check details request was cancelled.')
  error.name = 'AbortError'
  return error
}

export function rethrowCheckDetailsAbort(signal: AbortSignal | undefined, _error: unknown): void {
  if (signal?.aborted) {
    throw createCheckDetailsAbortError()
  }
}

export function waitForCheckDetailsResolution<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => finish(() => reject(createCheckDetailsAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
    if (signal.aborted) {
      onAbort()
    }
  })
}
