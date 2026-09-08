const MAX_CONCURRENT = 4
let running = 0
type QueuedPlaneRequest = {
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
}
const queue: QueuedPlaneRequest[] = []

function createPlaneRequestAbortError(): Error {
  const error = new Error('Plane request aborted')
  error.name = 'AbortError'
  return error
}

export function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createPlaneRequestAbortError())
  }
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry: QueuedPlaneRequest = {
      resolve,
      reject,
      signal,
      onAbort: () => {
        const index = queue.indexOf(entry)
        if (index === -1) {
          return
        }
        queue.splice(index, 1)
        reject(createPlaneRequestAbortError())
      }
    }
    signal?.addEventListener('abort', entry.onAbort, { once: true })
    queue.push(entry)
  })
}

export function release(): void {
  running -= 1
  let next = queue.shift()
  while (next) {
    next.signal?.removeEventListener('abort', next.onAbort)
    if (!next.signal?.aborted) {
      running += 1
      next.resolve()
      return
    }
    next.reject(createPlaneRequestAbortError())
    next = queue.shift()
  }
}
