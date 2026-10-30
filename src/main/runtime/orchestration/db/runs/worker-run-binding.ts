import type { DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { isSelfCreatedDispatch } from '../dispatch-depth'
import type { OrchestrationDb } from '../orchestration-db'
import {
  mailboxAddressOf,
  type OrchestrationCoordinatorKey
} from '../../orchestration-caller-identity'

/** The caller's active delegated Dispatches, matched by address then pane as check and send do. */
export function findCallerWorkerDispatches(
  db: OrchestrationDb,
  caller: OrchestrationCoordinatorKey
): DispatchContextRow[] {
  const address = mailboxAddressOf(caller)
  if (address === null) {
    return []
  }
  return db
    .getActiveDispatchMailboxOwners(address, caller.paneKey ?? undefined)
    .filter((dispatch) => !isSelfCreatedDispatch(dispatch))
}

/** A delegated Dispatch in this Run, or started from work in this Run. */
function callerDispatchWorkingForRun(
  dispatches: readonly DispatchContextRow[],
  db: OrchestrationDb,
  runId: string
): DispatchContextRow | undefined {
  for (const own of dispatches) {
    let row: DispatchContextRow | undefined = own
    const visited = new Set<string>()
    while (row) {
      if (row.run_id === runId || visited.has(row.id)) {
        return own
      }
      visited.add(row.id)
      row = row.creator_dispatch_id ? db.getDispatchContextById(row.creator_dispatch_id) : undefined
    }
  }
  return undefined
}

/** A worker cannot bind its own or ancestor Run, or use a takeover flag on another Run. */
export function workerRunBindingRefusal(
  db: OrchestrationDb,
  caller: OrchestrationCoordinatorKey,
  runId: string,
  attempted: { takeover: boolean; bind: boolean }
): OrchestrationError | null {
  const dispatches = findCallerWorkerDispatches(db, caller)
  const own = callerDispatchWorkingForRun(dispatches, db, runId)
  if (own) {
    const role =
      own.run_id === runId
        ? `You work Dispatch ${own.id} in Run ${runId}, so you cannot coordinate that Run.`
        : `You work Dispatch ${own.id} in Run ${own.run_id}, which was started from work in Run ${runId}, so you cannot coordinate Run ${runId}.`
    return new OrchestrationError(
      'worker_cannot_coordinate_own_run',
      `${role} Your mail arrives through plain \`orchestration check\` (no --run); report with \`orchestration send\`. No effects were applied.`,
      { effectsApplied: false, dispatchId: own.id }
    )
  }
  const first = dispatches[0]
  if (first && attempted.bind && attempted.takeover) {
    return new OrchestrationError(
      'worker_cannot_take_over_run',
      'A caller working an active Dispatch cannot use a takeover flag. No effects were applied.',
      { effectsApplied: false, dispatchId: first.id }
    )
  }
  return null
}

/** What a worker with no Run binding is told instead of a Run binding command. */
export function unboundWorkerMessage(dispatch: DispatchContextRow): string {
  return `You work Dispatch ${dispatch.id} in Run ${dispatch.run_id} and are not bound to a Run. Your mail arrives through plain \`orchestration check\` (no --run); report with \`orchestration send\`. No effects were applied.`
}
