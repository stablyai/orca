import type { RunRow } from '../../types'
import {
  mailboxAddressOf,
  runBoundToCoordinator,
  runCoordinatorKey,
  type OrchestrationCoordinatorKey
} from '../../orchestration-caller-identity'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../../shared/orchestration-run-pagination'
import {
  isEquivalentPaneKey,
  RUN_PANE_KEY_MATCH_SUFFIX_SQL,
  paneKeyMatchSuffix
} from '../pane-key-match'
import { exposeRunTimestamps } from '../utc-timestamp'
import { encodeRunListCursor, decodeRunListCursor } from '../run-list-cursor'
import type { RunListPage } from '../run-list-page'
import type { OrchestrationDb } from '../orchestration-db'
import { RUN_COLUMN_LIST } from '../row-column-lists'

export type LegacyAdoptedMailboxOwner = {
  runId: string
  terminalHandle: string
}

// Why: hoisted and wildcard-free so the per-publish run lookups hit the SyncDatabase statement cache.
const RUN_BY_ID_SQL = `SELECT ${RUN_COLUMN_LIST} FROM runs WHERE id = ?`
const RUNS_BOUND_TO_PANE_SQL = `SELECT ${RUN_COLUMN_LIST} FROM runs
         WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
           AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?
         ORDER BY rowid`
// Why: one statement so pane and Orca session id matches keep a single rowid order; the JS predicate decides.
const RUNS_BOUND_TO_COORDINATOR_SQL = `SELECT ${RUN_COLUMN_LIST} FROM runs
         WHERE legacy = 0 AND (
           (coordinator_pane_key IS NOT NULL AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?)
           OR coordinator_orca_session_id = ?
         )
         ORDER BY rowid`

export function getRun(this: OrchestrationDb, id: string): RunRow | undefined {
  const run = this.getRunRaw(id)
  return run ? exposeRunTimestamps(run) : undefined
}

export function getLegacyAdoptedRunMailboxOwner(
  this: OrchestrationDb
): LegacyAdoptedMailboxOwner | null {
  const adoption = this.getLegacyAdoption()
  if (!adoption) {
    return null
  }
  const terminalHandle = this.getUniqueLegacyCoordinatorHandle(adoption.adopted_run_id)
  return terminalHandle ? { runId: adoption.adopted_run_id, terminalHandle } : null
}

export function getRunMailboxOwnerIdsForHandle(
  this: OrchestrationDb,
  terminalHandle: string,
  legacyAdoptedMailboxOwner?: LegacyAdoptedMailboxOwner | null
): string[] {
  const runIds = (
    this.db
      .prepare(
        `SELECT coordinator.run_id
         FROM run_coordinator_handles AS coordinator
         JOIN runs ON runs.id = coordinator.run_id AND runs.legacy = 0
         WHERE coordinator.terminal_handle = ?
         ORDER BY coordinator.run_id`
      )
      .all(terminalHandle) as { run_id: string }[]
  ).map((row) => row.run_id)
  const adoptedOwner =
    legacyAdoptedMailboxOwner === undefined
      ? this.getLegacyAdoptedRunMailboxOwner()
      : legacyAdoptedMailboxOwner
  if (adoptedOwner?.terminalHandle === terminalHandle) {
    runIds.push(adoptedOwner.runId)
  }
  return [...new Set(runIds)].sort()
}

export function listRuns(
  this: OrchestrationDb,
  params: { limit?: number; cursor?: string } = {}
): RunListPage {
  if (params.limit === undefined && params.cursor === undefined) {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC')
      .all() as RunRow[]
    return { runs: rows.map(exposeRunTimestamps), nextCursor: null }
  }
  const limit = Math.min(
    Math.max(1, params.limit ?? ORCHESTRATION_RUN_PAGE_LIMIT),
    ORCHESTRATION_RUN_PAGE_LIMIT
  )
  const cursor = params.cursor ? decodeRunListCursor(params.cursor) : undefined
  const rows = (
    cursor
      ? this.db
          .prepare(
            `SELECT * FROM runs
           WHERE created_at < ? OR (created_at = ? AND id < ?)
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
          )
          .all(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
      : this.db
          .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(limit + 1)
  ) as RunRow[]
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  return {
    runs: pageRows.map(exposeRunTimestamps),
    nextCursor: hasMore ? encodeRunListCursor(pageRows.at(-1) as RunRow) : null
  }
}

export function getCurrentRunForPane(this: OrchestrationDb, paneKey: string): RunRow | undefined {
  const run = this.runsBoundToPane(paneKey)[0]
  return run ? exposeRunTimestamps(run) : undefined
}

// Why: the indexed suffix only narrows candidates; isEquivalentPaneKey still decides, so
// reminted tab halves keep matching and unparseable keys keep requiring an exact match.
export function runsBoundToPane(this: OrchestrationDb, paneKey: string): RunRow[] {
  return (
    this.db.prepare(RUNS_BOUND_TO_PANE_SQL).all(paneKeyMatchSuffix(paneKey)) as RunRow[]
  ).filter(
    (run) =>
      run.coordinator_pane_key !== null && isEquivalentPaneKey(run.coordinator_pane_key, paneKey)
  )
}

export function getRunRaw(this: OrchestrationDb, id: string): RunRow | undefined {
  return this.db.prepare(RUN_BY_ID_SQL).get(id) as RunRow | undefined
}

export function getCurrentRunForCoordinator(
  this: OrchestrationDb,
  caller: OrchestrationCoordinatorKey
): RunRow | undefined {
  const run = this.runsBoundToCoordinator(caller)[0]
  return run ? exposeRunTimestamps(run) : undefined
}

/** Runs bound to this caller by pane or by Orca session id; a caller without one matches as before. */
export function runsBoundToCoordinator(
  this: OrchestrationDb,
  caller: OrchestrationCoordinatorKey
): RunRow[] {
  if (caller.orcaSessionId === null) {
    return caller.paneKey === null ? [] : this.runsBoundToPane(caller.paneKey)
  }
  const suffix = caller.paneKey === null ? null : paneKeyMatchSuffix(caller.paneKey)
  const rows = this.db.prepare(RUNS_BOUND_TO_COORDINATOR_SQL).all(suffix, caller.orcaSessionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns the row shape its schema and row type define, like every row cast in db/.
  return (rows as RunRow[]).filter((run) => runBoundToCoordinator(run, caller))
}

export function unbindOtherRunsForCoordinator(
  this: OrchestrationDb,
  caller: OrchestrationCoordinatorKey,
  exceptRunId?: string
): void {
  for (const run of this.runsBoundToCoordinator(caller)) {
    if (run.id !== exceptRunId) {
      const address = mailboxAddressOf(runCoordinatorKey(run))
      if (address !== null) {
        this.routeAllUnreadDirectMessagesToRunMailbox(run.id, address)
      }
      this.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = NULL, coordinator_pane_key = NULL, coordinator_orca_session_id = NULL,
               coordinator_orca_session_id_generation = NULL,
               consumer_generation = consumer_generation + 1,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(run.id)
      this.fenceUnacknowledgedMailboxDeliveries(`run:${run.id}`)
    }
  }
}

export function requireRun(this: OrchestrationDb, runId: string): void {
  if (!this.getRunRaw(runId)) {
    throw new Error(`Run not found: ${runId}`)
  }
}

export type RunLookupMethods = {
  getRun: typeof getRun
  getLegacyAdoptedRunMailboxOwner: typeof getLegacyAdoptedRunMailboxOwner
  getRunMailboxOwnerIdsForHandle: typeof getRunMailboxOwnerIdsForHandle
  listRuns: typeof listRuns
  getCurrentRunForPane: typeof getCurrentRunForPane
  runsBoundToPane: typeof runsBoundToPane
  getCurrentRunForCoordinator: typeof getCurrentRunForCoordinator
  runsBoundToCoordinator: typeof runsBoundToCoordinator
  getRunRaw: typeof getRunRaw
  unbindOtherRunsForCoordinator: typeof unbindOtherRunsForCoordinator
  requireRun: typeof requireRun
}

export function attachRunLookup(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getRun,
    getLegacyAdoptedRunMailboxOwner,
    getRunMailboxOwnerIdsForHandle,
    listRuns,
    getCurrentRunForPane,
    runsBoundToPane,
    getCurrentRunForCoordinator,
    runsBoundToCoordinator,
    getRunRaw,
    unbindOtherRunsForCoordinator,
    requireRun
  })
}
