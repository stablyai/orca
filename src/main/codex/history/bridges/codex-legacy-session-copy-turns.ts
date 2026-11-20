import type { LegacySessionCopySwap } from './codex-legacy-session-copy'

const runningForCopy = new Map<string, Promise<LegacySessionCopySwap>>()

/** Every write of a copy's marker or names runs one at a time per copy; a second caller shares it. */
export function runAloneForCopy(
  copyPath: string,
  work: () => Promise<LegacySessionCopySwap>
): Promise<LegacySessionCopySwap> {
  const running = runningForCopy.get(copyPath)
  if (running) {
    return running
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
