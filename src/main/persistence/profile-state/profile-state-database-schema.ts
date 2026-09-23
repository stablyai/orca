// Schema 3 requires explicit automation storage metadata even when history is empty.

import { createProfileStateAutomationRunsTablesSql } from './profile-state-automation-runs'

export const PROFILE_STATE_DATABASE_SCHEMA_VERSION = 3
export const PROFILE_STATE_DOCUMENT_VERSION = 1

export const PROFILE_STATE_META_PROFILE_ID = 'profile_id'
export const PROFILE_STATE_META_REVISION = 'revision'
/** Records the legacy JSON bytes accepted by the SQLite authority bootstrap. */
export const PROFILE_STATE_META_LEGACY_JSON_ACCEPTANCE = 'legacy_json_acceptance'

export function createProfileStateTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS profile_state_meta (
    key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile_state_documents (
    domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL,
    domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL
  );
  ${createProfileStateAutomationRunsTablesSql()}`
}
