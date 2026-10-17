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
  /**
   * Skip rows that fail hash/metadata/JSON validation instead of throwing.
   * The remaining intact rows are returned. Used to recover the rest of the
   * profile when a torn write has left one row's content_hash stale.
   */
  salvage?: boolean
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
  let normalized: ReturnType<typeof readProfileStateAutomationRunsDocument>
  try {
    normalized =
      options.representation === 'validated'
        ? readProfileStateAutomationRunsDocument(db, profileRevision, 'validated')
        : options.representation === 'parsed'
          ? readProfileStateAutomationRunsDocument(db, profileRevision, 'parsed')
          : readProfileStateAutomationRunsDocument(db, profileRevision)
  } catch (error) {
    // Salvage mode drops a corrupt normalized automationRuns projection and
    // keeps the rest of the profile; otherwise the caller decides.
    if (options.salvage) {
      normalized = null
    } else {
      throw error
    }
  }
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
    let document: ReturnType<typeof validateProfileStateDocumentRow>
    try {
      document = validateProfileStateDocumentRow(row, {
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
    } catch (error) {
      // Salvage mode keeps the surviving rows; a corrupt row is dropped so the
      // rest of the profile still loads instead of quarantining the whole file.
      if (options.salvage) {
        continue
      }
      // Fail-closed otherwise: preserve the original diagnostic unchanged.
      throw error
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
