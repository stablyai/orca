import type { SessionSearchStore } from './storage/session-search-store'
import type { SessionSearchStateCounts } from './storage/session-search-store-types'
import type {
  SearchWorkerCommand,
  SearchWorkerResponse
} from './worker/session-search-worker-protocol'
import {
  readSessionSearchSnapshotRows,
  sessionSearchWorkerDelta
} from './session-search-snapshot-rows'
import { sessionSearchWorkEpoch } from './session-search-worker-write'
import { readIndexGeneration } from './storage/session-search-index-generation'

export function validateSessionSearchReadReceipt(
  command: SearchWorkerCommand,
  runtimeEpoch: number
): void {
  const receipt =
    command.op === 'work' && command.command.kind === 'acknowledge'
      ? command.command.work.receipt
      : command.op === 'candidates' &&
          command.command.kind === 'path' &&
          typeof command.command.read === 'object'
        ? command.command.read.receipt
        : undefined
  if (receipt && receipt.runtimeEpoch !== runtimeEpoch) {
    throw new Error('Stale session read receipt')
  }
}
export async function sessionSearchWorkerCandidates(
  store: SessionSearchStore,
  counts: SessionSearchStateCounts,
  command: Extract<SearchWorkerCommand, { op: 'candidates' }>,
  id: number,
  reset: boolean,
  runtimeEpoch: number
): Promise<SearchWorkerResponse> {
  const c = command.command
  const path = c.kind === 'withdraw' ? c.path : undefined
  const previous = path ? readSessionSearchSnapshotRows(store, path)[0] : undefined
  const result = await store.candidates(c)
  if (result.work) {
    sessionSearchWorkEpoch(result.work, runtimeEpoch)
  }
  return {
    id,
    reset,
    candidates: result,
    coverage:
      c.kind === 'path' && c.read ? readSessionSearchSnapshotRows(store, c.path) : undefined,
    deltas: path
      ? [sessionSearchWorkerDelta(store, counts, path, previous)]
      : result.withdrawn?.map((row) => sessionSearchWorkerDelta(store, counts, row.path, row)),
    counts,
    generation: readIndexGeneration(store.connection)
  }
}
