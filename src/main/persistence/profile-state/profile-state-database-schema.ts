// Schema 3 requires explicit automation storage metadata even when history is empty.

import {
  PROFILE_STATE_AUTOMATION_RUNS_META_TABLE,
  PROFILE_STATE_AUTOMATION_RUNS_TABLE
} from './profile-state-automation-runs-model'

export const PROFILE_STATE_DATABASE_SCHEMA_VERSION = 3
export const PROFILE_STATE_DOCUMENT_VERSION = 1

export const PROFILE_STATE_META_PROFILE_ID = 'profile_id'
export const PROFILE_STATE_META_REVISION = 'revision'
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
  CREATE TABLE IF NOT EXISTS ${PROFILE_STATE_AUTOMATION_RUNS_META_TABLE} (
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

/** Additive split-domain storage (see profile-state-document-parts); older v3 builds ignore it. */
export const PROFILE_STATE_DOCUMENT_PARTS_TABLE = 'profile_state_document_parts'
export const PROFILE_STATE_DOCUMENT_PARTS_META_TABLE = 'profile_state_document_parts_meta'

export function createProfileStateDocumentPartsTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${PROFILE_STATE_DOCUMENT_PARTS_META_TABLE} (
    domain TEXT PRIMARY KEY NOT NULL,
    domain_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    legacy_revision INTEGER
  );
  CREATE TABLE IF NOT EXISTS ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} (
    domain TEXT NOT NULL,
    part_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (domain, part_key)
  );`
}
