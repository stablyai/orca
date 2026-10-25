import type Database from '../../sqlite/sync-database'
import {
  hashProfileStatePayload,
  isRecord,
  ProfileStateDocumentCorruptionError
} from './profile-state-document-validation'
import {
  AUTOMATION_RUNS_ABSENT,
  AUTOMATION_RUNS_ARRAY,
  AUTOMATION_RUNS_DOMAIN,
  AUTOMATION_RUNS_DOCUMENT,
  AUTOMATION_RUNS_NULL,
  PROFILE_STATE_AUTOMATION_RUNS_TABLE,
  type AutomationRunIdentity,
  type AutomationRunsMeta,
  type NormalizedAutomationRunRow
} from './profile-state-automation-runs-model'

export function assertNoNormalizedAutomationRuns(db: Database.Database): void {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE}`)
    .get()
  if (isRecord(row) && row.count !== 0) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns rows exist for an empty domain',
      AUTOMATION_RUNS_DOMAIN
    )
  }
}

export function parseAutomationRunsMeta(row: unknown): AutomationRunsMeta {
  if (
    !isRecord(row) ||
    row.domain !== AUTOMATION_RUNS_DOMAIN ||
    (row.presence !== AUTOMATION_RUNS_ABSENT &&
      row.presence !== AUTOMATION_RUNS_DOCUMENT &&
      row.presence !== AUTOMATION_RUNS_NULL &&
      row.presence !== AUTOMATION_RUNS_ARRAY) ||
    typeof row.domain_version !== 'number' ||
    typeof row.revision !== 'number' ||
    typeof row.updated_at !== 'number' ||
    typeof row.content_hash !== 'string'
  ) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns metadata is malformed',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  if (
    !Number.isSafeInteger(row.domain_version) ||
    row.domain_version < 1 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < (row.presence === AUTOMATION_RUNS_DOCUMENT ? 0 : 1) ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < 0 ||
    (row.presence === AUTOMATION_RUNS_ABSENT || row.presence === AUTOMATION_RUNS_DOCUMENT
      ? row.content_hash !== ''
      : !/^[a-f0-9]{64}$/.test(row.content_hash))
  ) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns metadata is invalid',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  if (
    row.presence === AUTOMATION_RUNS_DOCUMENT &&
    (row.revision !== 0 || row.updated_at !== 0 || row.domain_version !== 1)
  ) {
    throw new ProfileStateDocumentCorruptionError(
      'AutomationRuns document storage marker is invalid',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  return {
    presence: row.presence,
    domainVersion: row.domain_version,
    revision: row.revision,
    updatedAt: row.updated_at,
    contentHash: row.content_hash
  }
}

export function parseNormalizedAutomationRunRow(
  row: unknown,
  retainParsedValue = false
): NormalizedAutomationRunRow & { value?: unknown } {
  if (
    !isRecord(row) ||
    typeof row.run_id !== 'string' ||
    typeof row.ordinal !== 'number' ||
    typeof row.payload !== 'string' ||
    typeof row.content_hash !== 'string' ||
    typeof row.revision !== 'number' ||
    typeof row.updated_at !== 'number' ||
    !Number.isSafeInteger(row.ordinal) ||
    row.ordinal < 0 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < 0 ||
    hashProfileStatePayload(row.payload) !== row.content_hash
  ) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns row is corrupt',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  // Individually invalid fragments can splice into a valid aggregate with matching IDs.
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload)
  } catch {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns row is invalid JSON',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  if (!isRecord(parsed) || parsed.id !== row.run_id) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns row identity is corrupt',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  return {
    id: row.run_id,
    ordinal: row.ordinal,
    payload: row.payload,
    contentHash: row.content_hash,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(retainParsedValue ? { value: parsed } : {})
  }
}

export function parseAutomationRunIdentity(row: unknown): AutomationRunIdentity {
  if (
    !isRecord(row) ||
    typeof row.run_id !== 'string' ||
    typeof row.ordinal !== 'number' ||
    typeof row.content_hash !== 'string' ||
    !Number.isSafeInteger(row.ordinal) ||
    row.ordinal < 0
  ) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns row is malformed',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  return {
    id: row.run_id,
    ordinal: row.ordinal,
    contentHash: row.content_hash
  }
}
