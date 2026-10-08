// ── Concurrency limiter — max 4 parallel Linear API calls ────────────
const MAX_CONCURRENT = 4
let running = 0
type QueuedLinearRequest = {
  resolve: () => void
  signal?: AbortSignal
  onAbort: () => void
}
const queue: QueuedLinearRequest[] = []

export function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry: QueuedLinearRequest = {
      resolve,
      signal,
      onAbort: () => {
        const index = queue.indexOf(entry)
        if (index === -1) {
          return
        }
        queue.splice(index, 1)
        reject(signal?.reason)
      }
    }
    signal?.addEventListener('abort', entry.onAbort, { once: true })
    queue.push(entry)
  })
}

export function release(): void {
  running--
  const next = queue.shift()
  if (next) {
    next.signal?.removeEventListener('abort', next.onAbort)
    running++
    next.resolve()
  }
}
