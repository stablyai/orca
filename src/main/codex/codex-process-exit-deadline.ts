export async function waitForProcessExitUntil(
  exitPromise: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([exitPromise, timeout])
  } finally {
    // Why: this runs in a short-lived entry; a live grace timer delays the
    // parent spawnSync even after the app-server process has already exited.
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
