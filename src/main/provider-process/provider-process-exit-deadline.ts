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

/** A close can return once the kill is sent; callers that need the exit itself (removing what the
 *  process may still write on its way out) wait for it here, at once when it was already seen. */
export function waitForProviderExitUntil(
  child: { onExit(listener: () => void): void },
  timeoutMs: number
): Promise<void> {
  return waitForProcessExitUntil(new Promise<void>((resolve) => child.onExit(resolve)), timeoutMs)
}
