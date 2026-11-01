const MAX_CONCURRENT = 4
export const TEA_ADMISSION_TIMEOUT_MS = 30_000
let running = 0
type QueueEntry = {
  grant: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cancelled: boolean
}
const queue: QueueEntry[] = []

export function acquire(timeoutMs = TEA_ADMISSION_TIMEOUT_MS): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry: QueueEntry = {
      grant: () => {
        clearTimeout(entry.timer)
        running += 1
        resolve()
      },
      reject: (error) => {
        clearTimeout(entry.timer)
        reject(error)
      },
      timer: setTimeout(() => {
        entry.cancelled = true
        const index = queue.indexOf(entry)
        if (index !== -1) {
          queue.splice(index, 1)
        }
        entry.reject(new Error('Timed out waiting for a Gitea operation slot.'))
      }, timeoutMs),
      cancelled: false
    }
    queue.push(entry)
  })
}

export function release(): void {
  running -= 1
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || next.cancelled) {
      continue
    }
    next.grant()
    return
  }
}
