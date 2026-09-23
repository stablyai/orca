import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { readProfileStateRevision } from './profile-state-revision'
import {
  hashProfileStatePayload,
  ProfileStateDocumentCorruptionError,
  type ProfileStateDocument,
  type ProfileStateParsedDocument
} from './profile-state-document-validation'
import {
  AUTOMATION_RUNS_ABSENT,
  AUTOMATION_RUNS_DOCUMENT,
  AUTOMATION_RUNS_DOMAIN,
  AUTOMATION_RUNS_NULL,
  PROFILE_STATE_AUTOMATION_RUNS_TABLE,
  type AutomationRunsMeta
} from './profile-state-automation-runs-model'
import {
  assertNoNormalizedAutomationRuns,
  parseNormalizedAutomationRunRow
} from './profile-state-automation-runs-validation'

import { readCurrentAutomationRunsState } from './profile-state-automation-runs-storage'

/** Undefined means explicit document storage; null means the domain is absent. */
export function readProfileStateAutomationRunsDocument(
  db: Database.Database,
  profileRevision?: number
): ProfileStateDocument | null | undefined
export function readProfileStateAutomationRunsDocument(
  db: Database.Database,
  profileRevision: number,
  representation: 'parsed'
): ProfileStateParsedDocument | null | undefined
export function readProfileStateAutomationRunsDocument(
  db: Database.Database,
  profileRevision = readProfileStateRevision(db),
  representation: 'serialized' | 'parsed' = 'serialized'
): ProfileStateDocument | ProfileStateParsedDocument | null | undefined {
  const meta = readCurrentAutomationRunsState(db, profileRevision)
  if (meta.presence === AUTOMATION_RUNS_DOCUMENT) {
    return undefined
  }
  if (meta.presence === AUTOMATION_RUNS_ABSENT) {
    assertNoNormalizedAutomationRuns(db)
    return null
  }
  if (meta.presence === AUTOMATION_RUNS_NULL) {
    if (meta.contentHash !== hashProfileStatePayload('null')) {
      throw new ProfileStateDocumentCorruptionError(
        'Normalized automationRuns null hash mismatch',
        AUTOMATION_RUNS_DOMAIN
      )
    }
    assertNoNormalizedAutomationRuns(db)
    return makeAutomationRunsDocument(
      'null',
      meta,
      representation === 'parsed' ? { value: null } : undefined
    )
  }

  // Sort references instead of copying large payloads into SQLite's temporary sort table.
  const parsedRows = db
    .prepare(
      `SELECT run_id, ordinal, payload, content_hash, revision, updated_at FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE}`
    )
    .all()
    .map((row) => parseNormalizedAutomationRunRow(row, representation === 'parsed'))
    .sort((left, right) => left.ordinal - right.ordinal)
  const payloads: string[] = []
  const values: unknown[] = []
  const aggregate = representation === 'parsed' ? createHash('sha256').update('[') : undefined
  const ids = new Set<string>()
  parsedRows.forEach((parsed, index) => {
    if (parsed.ordinal !== index || ids.has(parsed.id)) {
      throw new ProfileStateDocumentCorruptionError(
        'Normalized automationRuns ordering is corrupt',
        AUTOMATION_RUNS_DOMAIN
      )
    }
    if (
      parsed.revision > meta.revision ||
      (parsed.revision === meta.revision && parsed.updatedAt !== meta.updatedAt)
    ) {
      throw new ProfileStateDocumentCorruptionError(
        'Normalized automationRuns row metadata is inconsistent',
        AUTOMATION_RUNS_DOMAIN
      )
    }
    ids.add(parsed.id)
    if (aggregate) {
      if (index > 0) {
        aggregate.update(',')
      }
      aggregate.update(parsed.payload, 'utf8')
      values.push(parsed.value)
    } else {
      payloads.push(parsed.payload)
    }
  })
  const payload = aggregate ? '' : `[${payloads.join(',')}]`
  const contentHash = aggregate
    ? aggregate.update(']').digest('hex')
    : hashProfileStatePayload(payload)
  if (contentHash !== meta.contentHash) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns aggregate hash mismatch',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  return makeAutomationRunsDocument(payload, meta, aggregate ? { value: values } : undefined)
}

function makeAutomationRunsDocument(
  payload: string,
  meta: AutomationRunsMeta,
  parsed?: { value: unknown }
): ProfileStateDocument | ProfileStateParsedDocument {
  return {
    domain: AUTOMATION_RUNS_DOMAIN,
    ...(parsed ?? { payload }),
    domainVersion: meta.domainVersion,
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    contentHash: meta.contentHash
  }
}
