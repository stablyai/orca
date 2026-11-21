import type { LegacySessionCopySwap } from './codex-legacy-session-copy'

type CopyTurnKind = 'swap' | 'protect'
const runningForCopy = new Map<
  string,
  { kind: CopyTurnKind; task: Promise<LegacySessionCopySwap> }
>()

/**
 * Every write of a copy's marker or names runs one at a time per copy; a second caller shares it,
 * except a swap, which runs after a protect rather than taking its `none`.
 */
export function runAloneForCopy(
  copyPath: string,
  kind: CopyTurnKind,
  work: () => Promise<LegacySessionCopySwap>
): Promise<LegacySessionCopySwap> {
  const running = runningForCopy.get(copyPath)
  if (running) {
    return kind === 'swap' && running.kind === 'protect'
      ? running.task.then(() => runAloneForCopy(copyPath, kind, work))
      : running.task
  }
  const task = work()
    .catch((error: unknown): 'deferred' => {
      console.warn('[codex-session-bridge] Legacy session copy left in place:', copyPath, error)
      return 'deferred'
    })
    .finally(() => runningForCopy.delete(copyPath))
  runningForCopy.set(copyPath, { kind, task })
  return task
}

/** Settles once whatever is writing the copy's marker or names now is done. */
export async function waitForCopyTurn(copyPath: string): Promise<void> {
  await runningForCopy.get(copyPath)?.task
}
