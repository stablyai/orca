const runningForCopy = new Map<string, Promise<unknown>>()

/** Every write of a copy's marker or names runs one at a time per copy; a second caller shares it. */
export function runAloneForCopy<T>(
  copyPath: string,
  work: () => Promise<T>
): Promise<T | 'deferred'> {
  const running = runningForCopy.get(copyPath)
  if (running) {
    return running as Promise<T | 'deferred'>
  }
  const task = work()
    .catch((error: unknown): 'deferred' => {
      console.warn('[codex-session-bridge] Legacy session copy left in place:', copyPath, error)
      return 'deferred'
    })
    .finally(() => runningForCopy.delete(copyPath))
  runningForCopy.set(copyPath, task)
  return task
}

/** Settles once whatever is writing the copy's marker or names now is done. */
export async function waitForCopyTurn(copyPath: string): Promise<void> {
  await runningForCopy.get(copyPath)
}
