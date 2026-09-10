const MAX_CONCURRENT = 4
const LIST_RESERVATION_BYTES = 1_179_648
const LIST_RESERVATION_ALLOWANCE = 32 * 1024 * 1024
let running = 0
let reserved = 0
const queue: { start: () => void; cancel: () => void }[] = []

export function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const detach = (): void => signal?.removeEventListener('abort', waiter.cancel)
    const waiter = {
      start: (): void => {
        detach()
        running++
        resolve()
      },
      cancel: (): void => {
        const index = queue.indexOf(waiter)
        if (index === -1) {
          return
        }
        queue.splice(index, 1)
        detach()
        reject(signal?.reason)
      }
    }
    queue.push(waiter)
    signal?.addEventListener('abort', waiter.cancel, { once: true })
  })
}

export function release(): void {
  running--
  queue.shift()?.start()
}

export function reserveLinearListing(): (() => void) | null {
  if (reserved + LIST_RESERVATION_BYTES > LIST_RESERVATION_ALLOWANCE) {
    return null
  }
  reserved += LIST_RESERVATION_BYTES
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    reserved -= LIST_RESERVATION_BYTES
  }
}
