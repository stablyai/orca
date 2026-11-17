import type { OrchestrationDb } from '../../db/orchestration-db'
import type { WorkerDispatchRow } from '../../db/orchestration-records'
import { reportWorkerTurnStop } from './worker-turn-stop-report'

/** What a failed start left behind, as its residual resources name it. */
function describeLeftover(residualResources: string): string | undefined {
  let entries: unknown
  try {
    entries = JSON.parse(residualResources)
  } catch {
    return undefined
  }
  const described = (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }
    const { kind, id, name }: { kind?: unknown; id?: unknown; name?: unknown } = entry
    if (typeof kind !== 'string' || typeof id !== 'string') {
      return []
    }
    if (kind !== 'worktree') {
      return [`${kind} ${id}`]
    }
    // Worktree ids are `<repo id>::<path>`.
    const path = id.slice(id.indexOf('::') + 2)
    return [typeof name === 'string' && name ? `workspace ${name} (${path})` : `workspace ${path}`]
  })
  return described.length > 0 ? described.join(', ') : undefined
}

/** A failed start leaves its task unowned, and the caller may never have read the start's receipt. */
export function reportFailedWorkerStart(
  db: OrchestrationDb,
  worker: WorkerDispatchRow,
  notify: (handle: string, messageType: string) => void
): void {
  const dispatch = db.getDispatchContextById(worker.dispatch_id)
  if (!dispatch || worker.state !== 'failed') {
    return
  }
  const settled =
    dispatch.status === 'failed' || dispatch.status === 'circuit_broken'
      ? dispatch.status
      : undefined
  reportWorkerTurnStop(
    db,
    { kind: 'local', dispatch },
    {
      from: `dispatch:${dispatch.id}`,
      reason: 'lost',
      cause: `it never started: ${worker.last_error ?? 'its start failed'}`,
      lastOutput: undefined,
      leftover: describeLeftover(worker.residual_resources),
      // A start that failed after its terminal opened still has output to read.
      ...(worker.agent_terminal_handle || dispatch.assignee_handle ? {} : { neverStarted: true }),
      ...(settled ? { settled } : {})
    },
    { getDb: () => db, isWaitingForMail: () => false, notify }
  )
}
