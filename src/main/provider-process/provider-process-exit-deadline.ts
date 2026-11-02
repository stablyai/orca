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
    // A live grace timer delays the parent spawnSync even after this short-lived entry exits.
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
