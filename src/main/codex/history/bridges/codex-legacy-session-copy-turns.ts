import type { LegacySessionCopySwap } from './codex-legacy-session-copy'

/**
 * `full`: a swap with no read limit, as a resume needs; `limited`: a pass's protect or swap;
 * `settle`: giving a copy moved aside its name back.
 */
type CopyTurnKind = 'full' | 'limited' | 'settle'
const runningForCopy = new Map<
  string,
  { kind: CopyTurnKind; task: Promise<LegacySessionCopySwap> }
>()

/** Whether a caller may take the running task's result instead of running its own work. */
function servedBy(kind: CopyTurnKind, running: CopyTurnKind): boolean {
  return kind === 'limited' || (kind === 'full' && running === 'full')
}

/**
 * Every write of a copy's marker or names runs one at a time per copy. A caller the running task
 * serves shares its result; any other runs after it.
 */
export function runAloneForCopy(
  copyPath: string,
  kind: CopyTurnKind,
  work: () => Promise<LegacySessionCopySwap>
): Promise<LegacySessionCopySwap> {
  const running = runningForCopy.get(copyPath)
  if (running) {
    return servedBy(kind, running.kind)
      ? running.task
      : running.task.then(() => runAloneForCopy(copyPath, kind, work))
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
