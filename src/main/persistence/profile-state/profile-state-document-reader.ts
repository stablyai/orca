import type Database from '../../sqlite/sync-database'
import { readProfileStateAutomationRunsDocument } from './profile-state-automation-runs'
import {
  assertProfileStateDocumentRevision,
  readProfileStateRevision
} from './profile-state-revision'
import {
  ProfileStateDocumentCorruptionError,
  validateProfileStateDocumentRow,
  type ProfileStateDocument,
  type ProfileStateParsedDocument,
  type ProfileStateValidatedDocument
} from './profile-state-document-validation'

export type ReadProfileStateDocumentsOptions = {
  /** The profile revision already read by a surrounding snapshot. */
  profileRevision?: number
}

/** Read the authoritative rows after checking their hash, shape, and JSON payload. */
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
      `SELECT domain, payload, domain_version, revision, updated_at, content_hash
       FROM profile_state_documents ORDER BY rowid`
    )
    .iterate()
  const documents: (
    | ProfileStateDocument
    | ProfileStateParsedDocument
    | ProfileStateValidatedDocument
  )[] = []
  for (const row of rows) {
    const document = validateProfileStateDocumentRow(row, {
      retainParsedValue: options.representation === 'parsed'
    })
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
