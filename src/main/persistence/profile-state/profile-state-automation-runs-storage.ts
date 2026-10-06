import type Database from '../../sqlite/sync-database'
import { hashProfileStatePayload } from './profile-state-document-validation'
import { assertProfileStateDocumentRevision } from './profile-state-revision'
import {
  AUTOMATION_RUNS_DOCUMENT,
  AUTOMATION_RUNS_DOMAIN,
  PROFILE_STATE_AUTOMATION_RUNS_META_TABLE,
  type AutomationRunsMeta
} from './profile-state-automation-runs-model'
import {
  assertNoNormalizedAutomationRuns,
  parseAutomationRunsMeta
} from './profile-state-automation-runs-validation'

export function readCurrentAutomationRunsState(
  db: Database.Database,
  actualRevision: number
): AutomationRunsMeta {
  const row = db
    .prepare(
      `SELECT domain, presence, domain_version, revision, updated_at, content_hash
     FROM ${PROFILE_STATE_AUTOMATION_RUNS_META_TABLE} WHERE domain = ?`
    )
    .get(AUTOMATION_RUNS_DOMAIN)
  const meta = parseAutomationRunsMeta(row)
  assertProfileStateDocumentRevision(meta.revision, actualRevision, AUTOMATION_RUNS_DOMAIN)
  if (meta.presence === AUTOMATION_RUNS_DOCUMENT) {
    assertNoNormalizedAutomationRuns(db)
  }
  return meta
}

export function markAutomationRunsDocumentStorage(db: Database.Database): void {
  db.prepare(
    `INSERT INTO ${PROFILE_STATE_AUTOMATION_RUNS_META_TABLE}
     (domain, presence, domain_version, revision, updated_at, content_hash)
     VALUES (?, ?, 1, 0, 0, '')
     ON CONFLICT(domain) DO UPDATE SET presence = excluded.presence,
     domain_version = 1, revision = 0, updated_at = 0, content_hash = ''`
  ).run(AUTOMATION_RUNS_DOMAIN, AUTOMATION_RUNS_DOCUMENT)
}

/** Retain the key's JSON position without retaining a second history payload. */
export function compactAutomationRunsDocument(db: Database.Database): void {
  db.prepare(
    `UPDATE profile_state_documents SET payload = 'null', content_hash = ?
     WHERE domain = ? AND payload <> 'null'`
  ).run(hashProfileStatePayload('null'), AUTOMATION_RUNS_DOMAIN)
}
