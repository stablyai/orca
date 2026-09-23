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
  type ProfileStateParsedDocument
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
  options: ReadProfileStateDocumentsOptions & { representation?: 'parsed' } = {}
): readonly (ProfileStateDocument | ProfileStateParsedDocument)[] {
  const profileRevision = options.profileRevision ?? readProfileStateRevision(db)
  const normalized =
    options.representation === 'parsed'
      ? readProfileStateAutomationRunsDocument(db, profileRevision, 'parsed')
      : readProfileStateAutomationRunsDocument(db, profileRevision)
  const rows = db
    .prepare(
      `SELECT domain, payload, domain_version, revision, updated_at, content_hash
       FROM profile_state_documents ORDER BY rowid`
    )
    .all()
  const documents = rows.map((row): ProfileStateDocument | ProfileStateParsedDocument => {
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
    if (options.representation === 'parsed') {
      const { payload: _payload, ...parsedDocument } = document
      return { ...parsedDocument, value: document.value }
    }
    return document
  })
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
