import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../../../../../shared/orchestration-fleet-projection'
import type { WorkerTerminalListState } from '../../../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { WORKER_LIST_CURSOR_EXPIRED_MESSAGE } from '../../../../orchestration/db/worker-terminal/worker-terminal-listing'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { defineMethod, type RpcMethod } from '../../../core'
import {
  applyFederatedFleetObservations,
  readFederatedFleetSnapshots
} from '../federation/federated-fleet-snapshot'
import {
  decodeWorkerListCursor,
  encodeWorkerListCursor,
  type WorkerListCursor
} from './worker-list-cursor'
import {
  createWorkerListSnapshot,
  ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS,
  pinWorkerListSnapshot,
  readWorkerListSnapshot
} from './worker-list-snapshot-store'
import { projectWorkerFleet, type WorkerListPageParams } from './worker-list-projection'
import { exposeWorkerTerminalResource } from './worker-release-completion'
import { WORKER_TERMINAL_LIST_STATES, WorkerListParams } from './worker-release-schemas'

export const ORCHESTRATION_WORKER_LIST_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.workerList',
  params: WorkerListParams,
  handler: async (params, { runtime }) => {
    const db = runtime.getOrchestrationDb()
    const paginationRequested =
      params.paginate === true || params.limit !== undefined || params.cursor !== undefined
    if (!paginationRequested) {
      const rows = db.listWorkerTerminalResources({
        runId: params.run,
        terminalState: params.terminalState,
        limit: ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS + 1
      })
      if (rows.length > ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS) {
        throw new OrchestrationError(
          'worker_list_snapshot_too_large',
          `Legacy worker-list results support at most ${ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS} rows; update the client to use pagination.`
        )
      }
      return projectWorkerListPage({
        runtime,
        params,
        limit: ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS,
        rows,
        snapshotCursor: null,
        completeProjection: true
      })
    }
    const limit = params.limit ?? ORCHESTRATION_FLEET_PAGE_MAX
    let cursor: WorkerListCursor | null = params.cursor
      ? decodeWorkerListCursor(params.cursor)
      : null
    if (params.cursor && !cursor) {
      const legacyKey = db.getWorkerTerminalOrderingKey(params.cursor)
      if (!legacyKey) {
        throw new OrchestrationError(
          'invalid_argument',
          `Unknown worker-list cursor ${params.cursor}.`
        )
      }
      const snapshot = db.getWorkerTerminalListingSnapshot(params.run)
      if (!snapshot) {
        return {
          workers: [],
          counts: {},
          page: { limit, total: 0, hasMore: false, nextCursor: null }
        }
      }
      cursor = { version: 2, snapshot, after: legacyKey }
    }
    if (cursor?.version === 3) {
      return projectWorkerListPage({
        runtime,
        params,
        limit,
        rows: readSnapshotRows(runtime, db, cursor, params, limit),
        snapshotCursor: cursor
      })
    }
    const snapshot = cursor?.snapshot ?? db.getWorkerTerminalListingSnapshot(params.run)
    if (!snapshot) {
      return {
        workers: [],
        counts: {},
        page: { limit, total: 0, hasMore: false, nextCursor: null }
      }
    }
    const rows = db.listWorkerTerminalResources({
      runId: params.run,
      terminalState: params.terminalState,
      snapshot,
      after: cursor?.after,
      limit:
        !cursor && params.terminalState
          ? ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS + 1
          : limit + 1
    })
    if (!cursor && params.terminalState && 'databaseId' in snapshot) {
      if (rows.length > ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS) {
        throw new OrchestrationError(
          'worker_list_snapshot_too_large',
          `Filtered worker-list snapshots support at most ${ORCHESTRATION_WORKER_LIST_SNAPSHOT_MAX_ROWS} rows.`
        )
      }
      if (rows.length <= limit) {
        return projectWorkerListPage({
          runtime,
          params,
          limit,
          rows,
          snapshotCursor: null,
          snapshot
        })
      }
      const snapshotId = createWorkerListSnapshot(runtime, {
        runId: params.run,
        terminalState: params.terminalState,
        databaseId: snapshot.databaseId,
        dispatchIds: rows.map((row) => row.dispatchId)
      })
      return projectWorkerListPage({
        runtime,
        params,
        limit,
        rows,
        snapshotCursor: { version: 3, snapshot: { id: snapshotId }, offset: 0 }
      })
    }
    return projectWorkerListPage({ runtime, params, limit, rows, snapshotCursor: cursor, snapshot })
  }
})

function readSnapshotRows(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  cursor: Extract<WorkerListCursor, { version: 3 }>,
  params: WorkerListPageParams,
  limit: number
) {
  const stored = readWorkerListSnapshot(runtime, cursor.snapshot.id, {
    runId: params.run,
    terminalState: params.terminalState
  })
  const dispatchIds = stored.dispatchIds.slice(cursor.offset, cursor.offset + limit + 1)
  const rows = db.listWorkerTerminalResources({ dispatchIds })
  if (
    rows.length !== dispatchIds.length ||
    rows.some((row, index) => row.dispatchId !== dispatchIds[index])
  ) {
    throw new OrchestrationError('worker_list_cursor_expired', WORKER_LIST_CURSOR_EXPIRED_MESSAGE)
  }
  return rows
}

async function projectWorkerListPage(args: {
  runtime: OrcaRuntimeService
  params: WorkerListPageParams
  limit: number
  rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>
  snapshotCursor: WorkerListCursor | null
  snapshot?: Exclude<WorkerListCursor, { version: 3 }>['snapshot']
  completeProjection?: boolean
}) {
  const pinnedSnapshot =
    args.snapshotCursor?.version === 3
      ? pinWorkerListSnapshot(args.runtime, args.snapshotCursor.snapshot.id, {
          runId: args.params.run,
          terminalState: args.params.terminalState
        })
      : null
  try {
    return await projectWorkerListPageWithFilteredSnapshot(args, pinnedSnapshot?.snapshot ?? null)
  } finally {
    pinnedSnapshot?.release()
  }
}

async function projectWorkerListPageWithFilteredSnapshot(
  args: {
    runtime: OrcaRuntimeService
    params: WorkerListPageParams
    limit: number
    rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>
    snapshotCursor: WorkerListCursor | null
    snapshot?: Exclude<WorkerListCursor, { version: 3 }>['snapshot']
    completeProjection?: boolean
  },
  filteredSnapshot: ReturnType<typeof readWorkerListSnapshot> | null
) {
  const { runtime, params, limit, rows, snapshotCursor } = args
  const db = runtime.getOrchestrationDb()
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const authorityNow = Date.now()
  const attentionFacts = db.getWorkerAttentionFactsForDispatches(
    pageRows.map((row) => row.dispatchId),
    authorityNow
  )
  const statuses = runtime.getOrchestrationFleetAgentStatusSnapshot()
  const fleet = projectWorkerFleet({
    rows: pageRows,
    attentionFacts,
    statuses,
    limit,
    now: authorityNow,
    completeProjection: args.completeProjection
  })
  const federated = params.includeRemote
    ? await readFederatedFleetSnapshots({
        runtime,
        db,
        dispatchIds: pageRows.map((row) => row.dispatchId)
      })
    : null
  if (federated) {
    applyFederatedFleetObservations(fleet, federated, fleet.durable)
  }
  // Total and counts must come out of one row set. A pinned filtered cursor's row set is its
  // membership; deriving the total from that and the counts from a live scan of the extent
  // reported a total no count could reach once a pinned row left the filter.
  const pinnedCount = filteredSnapshot?.dispatchIds.length
  const inventory =
    pinnedCount !== undefined && params.terminalState
      ? { total: pinnedCount, counts: { [params.terminalState]: pinnedCount } }
      : db.countWorkerTerminalInventory({
          runId: params.run,
          terminalState: params.terminalState,
          snapshot: args.snapshot
        })
  const nextRow = pageRows.at(-1)
  fleet.page = {
    limit,
    total: inventory.total,
    hasMore,
    nextCursor:
      hasMore && nextRow
        ? snapshotCursor?.version === 3
          ? encodeWorkerListCursor({
              ...snapshotCursor,
              offset: snapshotCursor.offset + pageRows.length
            })
          : encodeWorkerListCursor(
              args.snapshot && 'databaseId' in args.snapshot
                ? {
                    version: 2,
                    snapshot: args.snapshot,
                    after: {
                      createdAt: nextRow.createdAt,
                      dispatchId: nextRow.dispatchId,
                      databaseId: nextRow.databaseId
                    }
                  }
                : {
                    version: 1,
                    snapshot: args.snapshot!,
                    after: {
                      createdAt: nextRow.createdAt,
                      dispatchId: nextRow.dispatchId,
                      databaseId: nextRow.databaseId
                    }
                  }
            )
        : null
  }
  const rowsByDispatchId = new Map(pageRows.map((row) => [row.dispatchId, row]))
  const workers = fleet.workers.map((projection) => {
    const row = rowsByDispatchId.get(projection.dispatchId)!
    return {
      dispatchId: row.dispatchId,
      taskId: row.taskId,
      runId: row.runId,
      workerState: row.workerState,
      dispatchStatus: row.dispatchStatus,
      agentTerminalHandle: row.agentTerminalHandle,
      terminalState: row.terminalState,
      resource: row.resource ? exposeWorkerTerminalResource(row.resource) : null,
      // Why: `projection.resource` restated id/ownerDispatchId/releaseState/terminalState
      // that the row already carries; only the derived ownership classification is new.
      projection: {
        ...projection,
        resource:
          projection.resource.state === 'absent'
            ? projection.resource
            : { state: projection.resource.state }
      }
    }
  })
  const counts = Object.fromEntries(
    WORKER_TERMINAL_LIST_STATES.flatMap((state) =>
      inventory.counts[state] ? [[state, inventory.counts[state]]] : []
    )
  ) as Partial<Record<WorkerTerminalListState, number>>
  return {
    workers,
    counts,
    page: fleet.page,
    ...(federated?.errors.length ? { partialHostErrors: federated.errors } : {})
  }
}
