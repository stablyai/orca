import { isOrcaSessionId } from '../../../../../shared/orca-session-address'
import type { OrchestrationDb } from '../orchestration-db'
import { sameExactCaller, type RunCallerKey } from './run-actor'

export type RunAuthorityRow = {
  run_id: string
  creating_dispatch_id: string | null
  creating_task_id: string | null
  parent_run_id: string | null
  creating_home_peer: string | null
  owner_task_id: string | null
  owner_home_peer: string | null
  last_handle: string | null
  last_pane_key: string | null
  last_session_id: string | null
  last_process_incarnation: string | null
}
export type RunHandoverRow = {
  run_id: string
  grantor_key: string
  target_task_id: string | null
  target_caller_key: string | null
  expires_at: number
}

export function getRunAuthority(db: OrchestrationDb, runId: string): RunAuthorityRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Complete schema projection of run_authority.
  return db.db.prepare('SELECT * FROM run_authority WHERE run_id = ?').get(runId) as
    | RunAuthorityRow
    | undefined
}

export function lastRunCaller(row: RunAuthorityRow): RunCallerKey {
  return {
    terminalHandle: row.last_handle,
    paneKey: row.last_pane_key,
    orcaSessionId:
      row.last_session_id && isOrcaSessionId(row.last_session_id) ? row.last_session_id : null,
    processIncarnation: row.last_process_incarnation
  }
}

export function getRunHandover(db: OrchestrationDb, runId: string): RunHandoverRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Complete schema projection of run_handovers.
  return db.db.prepare('SELECT * FROM run_handovers WHERE run_id = ?').get(runId) as
    | RunHandoverRow
    | undefined
}

export function storeRunHandover(db: OrchestrationDb, row: RunHandoverRow): void {
  db.db
    .prepare(`INSERT OR REPLACE INTO run_handovers
    (run_id, grantor_key, target_task_id, target_caller_key, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(row.run_id, row.grantor_key, row.target_task_id, row.target_caller_key, row.expires_at)
}

export function decodeRunCaller(value: string): RunCallerKey | null {
  let key: unknown
  try {
    key = JSON.parse(value)
  } catch {
    return null
  }
  if (
    !key ||
    typeof key !== 'object' ||
    !('terminalHandle' in key) ||
    !('paneKey' in key) ||
    !('orcaSessionId' in key) ||
    !('processIncarnation' in key)
  ) {
    return null
  }
  const { terminalHandle, paneKey, orcaSessionId, processIncarnation } = key
  if (
    !(terminalHandle === null || typeof terminalHandle === 'string') ||
    !(paneKey === null || typeof paneKey === 'string') ||
    !(
      orcaSessionId === null ||
      (typeof orcaSessionId === 'string' && isOrcaSessionId(orcaSessionId))
    ) ||
    !(processIncarnation === null || typeof processIncarnation === 'string')
  ) {
    return null
  }
  return { terminalHandle, paneKey, orcaSessionId, processIncarnation }
}

/** The seat trigger clears unproven process evidence; upgraded writes enrich it in the same transaction. */
export function recordRunCaller(
  db: OrchestrationDb,
  runId: string,
  caller: RunCallerKey,
  prior: RunAuthorityRow | undefined,
  handover: RunHandoverRow | undefined
): void {
  db.db
    .prepare(`UPDATE run_authority SET last_handle = ?, last_pane_key = ?,
    last_session_id = ?, last_process_incarnation = ? WHERE run_id = ?`)
    .run(
      caller.terminalHandle,
      caller.paneKey,
      caller.orcaSessionId,
      caller.processIncarnation,
      runId
    )
  if (prior && handover && sameExactCaller(lastRunCaller(prior), caller)) {
    storeRunHandover(db, handover)
  } else {
    db.db.prepare('DELETE FROM run_handovers WHERE run_id = ?').run(runId)
  }
}
