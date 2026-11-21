import type { LegacySessionCopySwap } from './codex-legacy-session-copy'

/** `full`: a swap with no read limit, as a resume needs; `limited`: a pass's protect or swap. */
type CopyTurnKind = 'full' | 'limited'
const runningForCopy = new Map<
  string,
  { kind: CopyTurnKind; task: Promise<LegacySessionCopySwap> }
>()

/**
 * Every write of a copy's marker or names runs one at a time per copy; a second caller shares it,
 * except a full swap, which runs after a limited one rather than taking its `none` or `deferred`.
 */
export function runAloneForCopy(
  copyPath: string,
  kind: CopyTurnKind,
  work: () => Promise<LegacySessionCopySwap>
): Promise<LegacySessionCopySwap> {
  const running = runningForCopy.get(copyPath)
  if (running) {
    return kind === 'full' && running.kind === 'limited'
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

/** Settles once nothing writes the copy's marker or names, including a swap queued behind one. */
export async function waitForCopyTurn(copyPath: string): Promise<void> {
  for (let running = runningForCopy.get(copyPath); running;) {
    await running.task
    running = runningForCopy.get(copyPath)
  }
}
