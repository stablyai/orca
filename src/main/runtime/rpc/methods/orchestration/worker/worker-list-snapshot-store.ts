import { randomUUID } from 'node:crypto'
import { BoundedMap } from '../../../../../../shared/bounded-map'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerTerminalListState } from '../../../../orchestration/worker-terminal-ownership'

export const ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS = 5_000
const ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ENTRIES = 32
const ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024
const ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ENTRY_BYTES = 512 * 1024

type WorkerListSnapshot = {
  runId: string | null
  terminalState: WorkerTerminalListState
  /** Dispatch-context watermark the ids were selected under; counts reuse it so later pages
   *  never report an inventory that includes rows the cursor cannot reach. */
  databaseId: number
  dispatchIds: string[]
}

type WorkerListSnapshotStore = {
  snapshots: BoundedMap<string, WorkerListSnapshot>
  pins: Map<string, number>
}

const storesByRuntime = new WeakMap<OrcaRuntimeService, WorkerListSnapshotStore>()

export function createWorkerListSnapshot(
  runtime: OrcaRuntimeService,
  params: {
    runId?: string
    terminalState: WorkerTerminalListState
    databaseId: number
    dispatchIds: string[]
  }
): string {
  const id = `wls_${randomUUID().replaceAll('-', '')}`
  const snapshot = {
    runId: params.runId ?? null,
    terminalState: params.terminalState,
    databaseId: params.databaseId,
    dispatchIds: params.dispatchIds
  }
  const store = storeFor(runtime)
  const stored = canRetainWithPinnedSnapshots(store, snapshot)
    ? store.snapshots.set(id, snapshot)
    : false
  if (!stored) {
    throw new OrchestrationError(
      'worker_list_snapshot_too_large',
      'The filtered worker inventory is too large to page as one bounded snapshot.'
    )
  }
  return id
}

export function readWorkerListSnapshot(
  runtime: OrcaRuntimeService,
  id: string,
  params: { runId?: string; terminalState?: WorkerTerminalListState }
): WorkerListSnapshot {
  const snapshot = storeFor(runtime).snapshots.get(id)
  if (!snapshot) {
    throw new OrchestrationError(
      'worker_list_cursor_expired',
      'This worker-list cursor expired or belongs to another runtime. Restart without --cursor.'
    )
  }
  if (
    snapshot.runId !== (params.runId ?? null) ||
    snapshot.terminalState !== params.terminalState
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'A worker-list cursor must be reused with the same Run and terminal-state filter.'
    )
  }
  return snapshot
}

export function pinWorkerListSnapshot(
  runtime: OrcaRuntimeService,
  id: string,
  params: { runId?: string; terminalState?: WorkerTerminalListState }
): { snapshot: WorkerListSnapshot; release: () => void } {
  const snapshot = readWorkerListSnapshot(runtime, id, params)
  const store = storeFor(runtime)
  store.pins.set(id, (store.pins.get(id) ?? 0) + 1)
  let released = false
  return {
    snapshot,
    release: () => {
      if (released) {
        return
      }
      released = true
      const remaining = (store.pins.get(id) ?? 1) - 1
      if (remaining > 0) {
        store.pins.set(id, remaining)
      } else {
        store.pins.delete(id)
      }
    }
  }
}

function storeFor(runtime: OrcaRuntimeService): WorkerListSnapshotStore {
  let store = storesByRuntime.get(runtime)
  if (!store) {
    const pins = new Map<string, number>()
    store = {
      snapshots: new BoundedMap({
        maxEntries: ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ENTRIES,
        maxBytes: ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_BYTES,
        maxEntryBytes: ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ENTRY_BYTES,
        sizeOf: retainedSnapshotBytes,
        onEvict: (_snapshot, id) => pins.delete(id)
      }),
      pins
    }
    storesByRuntime.set(runtime, store)
  }
  return store
}

function canRetainWithPinnedSnapshots(
  store: WorkerListSnapshotStore,
  snapshot: WorkerListSnapshot
): boolean {
  const snapshotBytes = retainedSnapshotBytes(snapshot)
  let pinnedBytes = 0
  let pinnedEntries = 0
  for (const id of store.snapshots.keys()) {
    if (!store.pins.has(id)) {
      continue
    }
    const pinned = store.snapshots.get(id)
    if (pinned) {
      pinnedEntries += 1
      pinnedBytes += retainedSnapshotBytes(pinned)
    }
  }
  return (
    snapshotBytes <= ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ENTRY_BYTES &&
    pinnedEntries < ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ENTRIES &&
    pinnedBytes + snapshotBytes <= ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_BYTES
  )
}

function retainedSnapshotBytes(snapshot: WorkerListSnapshot): number {
  let bytes =
    Buffer.byteLength(snapshot.runId ?? '') + Buffer.byteLength(snapshot.terminalState) + 8
  for (const dispatchId of snapshot.dispatchIds) {
    bytes += Buffer.byteLength(dispatchId) + 8
  }
  return bytes
}
