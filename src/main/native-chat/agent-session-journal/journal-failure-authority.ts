import type Database from '../../sqlite/sync-database'

const attached = new WeakSet<Database.Database>()
export const markJournalOrchestrationAttached = (db: Database.Database): void => {
  attached.add(db)
}
export const forgetJournalOrchestrationAttachment = (db: Database.Database): void => {
  attached.delete(db)
}
export const journalOrchestrationAttached = (db: Database.Database): boolean => attached.has(db)

export type JournalFailureAuthority = { runId: string; snapshot: string }

export const FAILURE_AUTHORITY_COLUMNS = `json_array(r.id,r.consumer_generation,r.coordinator_handle,r.coordinator_pane_key,
  CASE WHEN r.coordinator_orca_session_id_generation=r.consumer_generation THEN r.coordinator_orca_session_id END,
  d.id,d.status,d.consumer_generation,d.assignee_handle,d.assignee_orca_session_id,d.assignee_pane_key,d.process_incarnation,d.host_scope,d.capability_revoked_at)`

export function journalFailureAuthoritySql(db: Database.Database, grant: string): string {
  return journalOrchestrationAttached(db)
    ? `(${grant}.authority_json IS NULL OR EXISTS(SELECT 1 FROM orchestration_authority.dispatch_contexts d
      JOIN orchestration_authority.runs r ON r.id=d.run_id
      WHERE d.id=${grant}.dispatch_id AND d.status='dispatched'
      AND ${FAILURE_AUTHORITY_COLUMNS}=json_extract(${grant}.authority_json,'$.snapshot')))`
    : `${grant}.authority_json IS NULL`
}
