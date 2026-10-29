export function remainingDaemonRequestTimeoutMs(
  deadlineMs: number | undefined
): number | undefined {
  return deadlineMs === undefined ? undefined : Math.max(1, deadlineMs - Date.now())
}

// A read ahead of teardown gets at most a quarter of what remains, leaving the rest for checkpoint and kill.
export function teardownReadBudgetMs(capMs: number, deadlineMs: number | undefined): number {
  return Math.floor(
    Math.min(capMs, deadlineMs === undefined ? capMs : (deadlineMs - Date.now()) * 0.25)
  )
}

// The caller's wait is bounded without cancelling durable work, which keeps running and committing.
export async function awaitDaemonWorkWithinCallerDeadline(
  work: Promise<void>,
  deadlineMs: number
): Promise<boolean> {
  void work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, deadlineMs - Date.now()))
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
