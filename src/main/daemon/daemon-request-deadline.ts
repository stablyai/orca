export function remainingDaemonRequestTimeoutMs(
  deadlineMs: number | undefined
): number | undefined {
  return deadlineMs === undefined ? undefined : Math.max(1, deadlineMs - Date.now())
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
