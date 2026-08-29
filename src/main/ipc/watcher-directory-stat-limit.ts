// Why: one budget per process, not per watched root or per batch — the main-process flush and the
// watcher child's delivery queue both stat event paths against the same 4-thread libuv pool, so a
// storm across N roots must still queue behind a single cap.
export const DIRECTORY_STAT_CONCURRENCY = 8

let activeDirectoryStats = 0
const directoryStatWaiters: (() => void)[] = []

async function acquireDirectoryStatSlot(): Promise<void> {
  if (activeDirectoryStats < DIRECTORY_STAT_CONCURRENCY) {
    activeDirectoryStats++
    return
  }
  await new Promise<void>((resolve) => directoryStatWaiters.push(resolve))
}

function releaseDirectoryStatSlot(): void {
  const next = directoryStatWaiters.shift()
  if (next) {
    // Transfer the existing slot directly so a newly arriving task cannot
    // overtake this waiter and temporarily exceed the global budget.
    next()
    return
  }
  activeDirectoryStats--
}

export async function withDirectoryStatSlot<T>(stat: () => Promise<T>): Promise<T> {
  await acquireDirectoryStatSlot()
  try {
    return await stat()
  } finally {
    releaseDirectoryStatSlot()
  }
}
