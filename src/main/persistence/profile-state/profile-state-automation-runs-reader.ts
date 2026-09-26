import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { readProfileStateRevision } from './profile-state-revision'
import {
  hashProfileStatePayload,
  ProfileStateDocumentCorruptionError,
  type ProfileStateDocument,
  type ProfileStateParsedDocument,
  type ProfileStateValidatedDocument
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

type Representation = 'serialized' | 'parsed' | 'validated'
type ReadDocument =
  | ProfileStateDocument
  | ProfileStateParsedDocument
  | ProfileStateValidatedDocument

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
  profileRevision: number,
  representation: 'validated'
): ProfileStateValidatedDocument | null | undefined
export function readProfileStateAutomationRunsDocument(
  db: Database.Database,
  profileRevision = readProfileStateRevision(db),
  representation: Representation = 'serialized'
): ReadDocument | null | undefined {
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
      meta,
      representation === 'validated'
        ? {}
        : representation === 'parsed'
          ? { value: null }
          : { payload: 'null' }
    )
  }

  // Sort only stable keys; payloads stay outside the sorter and extra columns cannot shadow the key.
  const references = db.prepare(
    `SELECT run_id FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE} ORDER BY ordinal`
  )
  const row = db.prepare(
    `SELECT run_id, ordinal, payload, content_hash, revision, updated_at FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE} WHERE run_id = ?`
  )
  const payloads: string[] = []
  const values: unknown[] = []
  const aggregate = createHash('sha256').update('[')
  const ids = new Set<string>()
  let index = 0
  for (const reference of references.iterate()) {
    const parsed = parseNormalizedAutomationRunRow(
      row.get(reference.run_id),
      representation === 'parsed'
    )
    if (parsed.id !== reference.run_id || parsed.ordinal !== index || ids.has(parsed.id)) {
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
    if (index > 0) {
      aggregate.update(',')
    }
    aggregate.update(parsed.payload, 'utf8')
    if (representation === 'parsed') {
      values.push(parsed.value)
    } else if (representation === 'serialized') {
      payloads.push(parsed.payload)
    }
    index++
  }
  const contentHash = aggregate.update(']').digest('hex')
  if (contentHash !== meta.contentHash) {
    throw new ProfileStateDocumentCorruptionError(
      'Normalized automationRuns aggregate hash mismatch',
      AUTOMATION_RUNS_DOMAIN
    )
  }
  return makeAutomationRunsDocument(
    meta,
    representation === 'validated'
      ? {}
      : representation === 'parsed'
        ? { value: values }
        : { payload: `[${payloads.join(',')}]` }
  )
}

function makeAutomationRunsDocument(
  meta: AutomationRunsMeta,
  content: { payload: string } | { value: unknown } | Record<string, never>
): ReadDocument {
  return {
    domain: AUTOMATION_RUNS_DOMAIN,
    ...content,
    domainVersion: meta.domainVersion,
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    contentHash: meta.contentHash
  }
}
