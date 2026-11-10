// DLP and antivirus products hook CreateFileW/CloseHandle in every process; when several libuv
// worker threads sit inside the hook at once, the main process crashes (#40636). Bulk filesystem
// paths — agent PATH detection, skill root scans, git CLI resolution — keep at most this many
// operations in flight so at most two libuv workers enter the hook simultaneously. Healthy
// machines barely notice: batched listings verify only actual hits, and skill roots are small.

const WINDOWS_BULK_FS_CONCURRENCY = 2

const waiting: (() => void)[] = []
let inFlight = 0

function isWindows(): boolean {
  return process.platform === 'win32'
}

function release(): void {
  inFlight -= 1
  const next = waiting.shift()
  if (next) {
    next()
  }
}

/** Run one bulk filesystem unit of work under the Windows concurrency cap. */
export function runInWindowsBulkFsSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (!isWindows()) {
    return operation()
  }
  return new Promise<T>((resolveRun) => {
    const start = (): void => {
      operation().then(
        (value) => {
          release()
          resolveRun(value)
        },
        (error) => {
          release()
          resolveRun(Promise.reject(error))
        }
      )
    }
    if (inFlight < WINDOWS_BULK_FS_CONCURRENCY) {
      inFlight += 1
      start()
      return
    }
    waiting.push(() => {
      inFlight += 1
      start()
    })
  })
}

/** @internal - tests assert the cap without timing windows. */
export function _windowsBulkFsInFlight(): number {
  return inFlight
}
