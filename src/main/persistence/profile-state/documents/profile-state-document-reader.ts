import type Database from '../../../sqlite/sync-database'
import '../automation-runs/profile-state-automation-runs'
import { readProfileStateAutomationRunsDocument } from '../automation-runs/profile-state-automation-runs-reader'
import {
  assertProfileStateDocumentRevision,
  readProfileStateRevision
} from '../database/profile-state-revision'
import {
  PROFILE_STATE_DOCUMENT_ROW_COLUMNS,
  readProfileStateDocumentRow
} from '../document-parts/profile-state-document-parts-reader'
import {
  ProfileStateDocumentCorruptionError,
  type ProfileStateDocument,
  type ProfileStateParsedDocument,
  type ProfileStateValidatedDocument
} from './profile-state-document-validation'

export type ReadProfileStateDocumentsOptions = {
  /** Reuse the surrounding snapshot's revision. */
  profileRevision?: number
}

/** Validate hash, shape and JSON before returning authoritative rows. */
export function readProfileStateDocuments(
  db: Database.Database,
  options: ReadProfileStateDocumentsOptions & { representation: 'parsed' }
): readonly ProfileStateParsedDocument[]
export function readProfileStateDocuments(
  db: Database.Database,
  options?: ReadProfileStateDocumentsOptions
): readonly ProfileStateDocument[]
export function readProfileStateDocuments(
  db: Database.Database,
  options: ReadProfileStateDocumentsOptions & { representation: 'validated' }
): void
export function readProfileStateDocuments(
  db: Database.Database,
  options: ReadProfileStateDocumentsOptions & { representation?: 'parsed' | 'validated' } = {}
):
  | readonly (ProfileStateDocument | ProfileStateParsedDocument | ProfileStateValidatedDocument)[]
  | void {
  const profileRevision = options.profileRevision ?? readProfileStateRevision(db)
  const normalized =
    options.representation === 'validated'
      ? readProfileStateAutomationRunsDocument(db, profileRevision, 'validated')
      : options.representation === 'parsed'
        ? readProfileStateAutomationRunsDocument(db, profileRevision, 'parsed')
        : readProfileStateAutomationRunsDocument(db, profileRevision)
  const rows = db
    .prepare(
      `SELECT ${PROFILE_STATE_DOCUMENT_ROW_COLUMNS}
       FROM profile_state_documents ORDER BY rowid`
    )
    .iterate()
  const documents: (
    | ProfileStateDocument
    | ProfileStateParsedDocument
    | ProfileStateValidatedDocument
  )[] = []
  for (const row of rows) {
    const document = readProfileStateDocumentRow(db, row, options.representation === 'parsed')
    assertProfileStateDocumentRevision(document.revision, profileRevision, document.domain)
    if (
      normalized !== undefined &&
      document.domain === 'automationRuns' &&
      document.payload !== 'null'
    ) {
      throw new ProfileStateDocumentCorruptionError(
        'Normalized automationRuns placeholder is invalid',
        document.domain
      )
    }
    if (options.representation === 'validated') {
      continue
    }
    if (options.representation === 'parsed') {
      const { payload: _payload, ...parsedDocument } = document
      documents.push({ ...parsedDocument, value: document.value })
    } else {
      documents.push(document)
    }
  }
  if (options.representation === 'validated') {
    return
  }
  if (normalized === undefined) {
    return documents
  }
  const withoutAutomationRuns = documents.filter((document) => document.domain !== 'automationRuns')
  if (normalized === null) {
    return withoutAutomationRuns
  }
  const originalIndex = documents.findIndex((document) => document.domain === 'automationRuns')
  withoutAutomationRuns.splice(
    originalIndex === -1 ? withoutAutomationRuns.length : originalIndex,
    0,
    normalized
  )
  return withoutAutomationRuns
}
