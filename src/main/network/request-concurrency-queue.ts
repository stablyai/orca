export type RequestConcurrencyQueue = {
  acquire: (signal?: AbortSignal) => Promise<void>
  release: () => void
}

type QueuedRequest = {
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
}

/** A provider-owned slot pool, so one provider's burst or throttling never starves another's requests. */
export function createRequestConcurrencyQueue(
  maxConcurrent: number,
  providerLabel: string
): RequestConcurrencyQueue {
  let running = 0
  const queue: QueuedRequest[] = []

  function createAbortError(): Error {
    const error = new Error(`${providerLabel} request aborted`)
    error.name = 'AbortError'
    return error
  }

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError())
    }
    if (running < maxConcurrent) {
      running += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry: QueuedRequest = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = queue.indexOf(entry)
          if (index === -1) {
            return
          }
          queue.splice(index, 1)
          reject(createAbortError())
        }
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      queue.push(entry)
    })
  }

  function release(): void {
    running -= 1
    let next = queue.shift()
    while (next) {
      next.signal?.removeEventListener('abort', next.onAbort)
      if (!next.signal?.aborted) {
        running += 1
        next.resolve()
        return
      }
      next.reject(createAbortError())
      next = queue.shift()
    }
  }

  return { acquire, release }
}
