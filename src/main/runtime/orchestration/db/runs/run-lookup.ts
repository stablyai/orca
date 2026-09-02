import type { RunRow } from '../../types'
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

export type LegacyAdoptedMailboxOwner = {
  runId: string
  terminalHandle: string
}

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
    this.db
      .prepare(
        `SELECT * FROM runs
         WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
           AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?
         ORDER BY rowid`
      )
      .all(paneKeyMatchSuffix(paneKey)) as RunRow[]
  ).filter(
    (run) =>
      run.coordinator_pane_key !== null && isEquivalentPaneKey(run.coordinator_pane_key, paneKey)
  )
}

export function getRunRaw(this: OrchestrationDb, id: string): RunRow | undefined {
  return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
}

export function unbindOtherRunsForPane(
  this: OrchestrationDb,
  paneKey: string,
  exceptRunId?: string
): void {
  for (const run of this.runsBoundToPane(paneKey)) {
    if (run.id !== exceptRunId) {
      if (run.coordinator_handle) {
        this.routeAllUnreadDirectMessagesToRunMailbox(run.id, run.coordinator_handle)
      }
      this.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = NULL, coordinator_pane_key = NULL,
               consumer_generation = consumer_generation + 1,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(run.id)
      this.fenceOutstandingDelivery(run.id)
    }
  }
}

export function requireRun(this: OrchestrationDb, runId: string): void {
  if (!this.getRunRaw(runId)) {
    throw new Error(`Run not found: ${runId}`)
  }
}

export function fenceOutstandingDelivery(this: OrchestrationDb, runId: string): void {
  this.db
    .prepare("UPDATE deliveries SET status = 'fenced' WHERE run_id = ? AND status = 'outstanding'")
    .run(runId)
}

export type RunLookupMethods = {
  getRun: typeof getRun
  getLegacyAdoptedRunMailboxOwner: typeof getLegacyAdoptedRunMailboxOwner
  getRunMailboxOwnerIdsForHandle: typeof getRunMailboxOwnerIdsForHandle
  listRuns: typeof listRuns
  getCurrentRunForPane: typeof getCurrentRunForPane
  runsBoundToPane: typeof runsBoundToPane
  getRunRaw: typeof getRunRaw
  unbindOtherRunsForPane: typeof unbindOtherRunsForPane
  requireRun: typeof requireRun
  fenceOutstandingDelivery: typeof fenceOutstandingDelivery
}

export function attachRunLookup(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getRun,
    getLegacyAdoptedRunMailboxOwner,
    getRunMailboxOwnerIdsForHandle,
    listRuns,
    getCurrentRunForPane,
    runsBoundToPane,
    getRunRaw,
    unbindOtherRunsForPane,
    requireRun,
    fenceOutstandingDelivery
  })
}
