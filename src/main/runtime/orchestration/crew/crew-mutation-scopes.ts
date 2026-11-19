// Which crews a mutation can change: the Dispatches it wrote, and the parties of what it created.
import type { OrchestrationDb } from '../db/orchestration-db'

export const dispatchOf = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' &&
        value !== null &&
        'dispatchId' in value &&
        typeof value.dispatchId === 'string'
      ? value.dispatchId
      : undefined

/** Progress writes change one shown row's stage or liveness, never who a crew shows: patched, not rebuilt. */
export const progressMutations: ReadonlySet<keyof OrchestrationDb> = new Set([
  'recordWorkerStage',
  'markWorkerDispatchReady',
  'recordAttemptObservation'
])

/** Lifecycle writes about one existing Dispatch (or one remote attachment, keyed by it). */
export const dispatchMutations: ReadonlySet<keyof OrchestrationDb> = new Set([
  'reconcileFederatedWorkerStart',
  'reconcileMissingWorkerTerminal',
  'failWorkerStart',
  'markWorkerStartUnknown',
  'beginWorkerStop',
  'settleWorkerStop',
  'markWorkerStopUnknown',
  'abandonWorkerDispatch',
  'completeDispatch',
  'failDispatch',
  'markRemoteAttachmentReady',
  'recordRemoteAttachmentStage',
  'updateRemoteAttachmentSetupEvidence',
  'failRemoteAttachment',
  'beginRemoteAttachmentStop',
  'settleRemoteAttachmentStop',
  'markRemoteAttachmentStopUnknown',
  'requestRemoteAttachmentTerminalRelease',
  'settleRemoteAttachmentInRelayTransaction'
])

/** Task and Dispatch writes whose every crew-visible effect the worker status notice names: the
 *  Dispatches they wrote, and the parties of the ones they created. Anything they write that no
 *  notice names (a Task with no Dispatch) is a row no crew shows. */
export const noticedMutations: ReadonlySet<keyof OrchestrationDb> = new Set([
  'createDispatchContext',
  'createStartingWorkerDispatch',
  'prepareStartingWorkerAuthority',
  'completeActiveDispatchesForTask',
  'failActiveDispatchForTask',
  'settleWorkerReport',
  'settleWorkerReportInTransaction',
  'promoteReadyTasks',
  'updateTaskStatus',
  'transitionLifecycle',
  'createWorkerTerminalResourceStatement',
  'transferWorkerTerminalResourceStatement',
  'rekeyWorkerTerminalResourcePaneKey'
])

type DispatchWrites = { dispatchIds: Set<string>; created: Set<string> }

/** Collects every Dispatch the call wrote, by the worker status notice; null once one was removed
 *  (or `createsNothing` and one was created). */
export function collectDispatchWrites<T>(
  db: OrchestrationDb,
  run: () => T,
  createsNothing: boolean
): [T, DispatchWrites | null] {
  let writes: DispatchWrites | null = { dispatchIds: new Set(), created: new Set() }
  const previous = db.crewDispatchNotice
  db.crewDispatchNotice = (id, change) => {
    previous?.(id, change)
    if (!writes) {
      return
    }
    if (!id || change === 'deleted' || (change === 'inserted' && createsNothing)) {
      writes = null
    } else {
      writes.dispatchIds.add(id)
      if (change === 'inserted') {
        writes.created.add(id)
      }
    }
  }
  try {
    return [run(), writes]
  } finally {
    db.crewDispatchNotice = previous
  }
}

const createdPartyColumns = [
  'creator_orca_session_id',
  'creator_handle',
  'creator_pane_key',
  'assignee_orca_session_id',
  'assignee_handle',
  'assignee_pane_key'
] as const

/** New Dispatches' Runs (as `run:<id>`) and their creators and assignees: one keyed read per create,
 *  so a crew that shows none of them skips the rebuild. */
export function createdDispatchParties(db: OrchestrationDb, ids: Set<string>): Set<string> {
  const parties = new Set<string>()
  const rows = db.db
    .prepare(
      `SELECT run_id, ${createdPartyColumns.join(', ')} FROM dispatch_contexts
      WHERE id IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify([...ids]))
  for (const row of rows) {
    const run: unknown = Reflect.get(row, 'run_id')
    if (typeof run === 'string') {
      parties.add(`run:${run}`)
    }
    for (const column of createdPartyColumns) {
      const value: unknown = Reflect.get(row, column)
      if (typeof value === 'string' && value) {
        parties.add(value)
      }
    }
  }
  return parties
}

/** A new Run names only its coordinator; the crew showing that party reads it. */
export function runCoordinatorParties(params: unknown): Set<string> | null {
  if (typeof params !== 'object' || params === null) {
    return null
  }
  const parties = new Set<string>()
  for (const key of ['coordinatorHandle', 'coordinatorPaneKey', 'coordinatorOrcaSessionId']) {
    const value: unknown = Reflect.get(params, key)
    if (typeof value === 'string' && value) {
      parties.add(value)
    }
  }
  return parties.size > 0 ? parties : null
}
