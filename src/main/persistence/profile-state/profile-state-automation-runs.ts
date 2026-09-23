import type Database from '../../sqlite/sync-database'
import { markAutomationRunsDocumentStorage } from './profile-state-automation-runs-storage'
import {
  PROFILE_STATE_AUTOMATION_RUNS_META_TABLE,
  PROFILE_STATE_AUTOMATION_RUNS_TABLE
} from './profile-state-automation-runs-model'

export {
  PROFILE_STATE_AUTOMATION_RUNS_META_TABLE,
  PROFILE_STATE_AUTOMATION_RUNS_TABLE
} from './profile-state-automation-runs-model'
export type { AutomationRunPayload } from './profile-state-automation-runs-model'
export type { AutomationRunsWritePreparation } from './profile-state-automation-runs-writer'
export {
  applyProfileStateAutomationRuns,
  prepareProfileStateAutomationRunsDelta,
  prepareProfileStateAutomationRunsReplacement,
  rebuildProfileStateAutomationRunsProjection
} from './profile-state-automation-runs-writer'
export { readProfileStateAutomationRunsDocument } from './profile-state-automation-runs-reader'

export function createProfileStateAutomationRunsTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${PROFILE_STATE_AUTOMATION_RUNS_META_TABLE} (
    domain TEXT PRIMARY KEY NOT NULL,
    presence TEXT NOT NULL,
    domain_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${PROFILE_STATE_AUTOMATION_RUNS_TABLE} (
    run_id TEXT PRIMARY KEY NOT NULL,
    ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`
}

export function clearProfileStateAutomationRuns(db: Database.Database): void {
  db.prepare(`DELETE FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE}`).run()
  markAutomationRunsDocumentStorage(db)
}
