import type Database from '../../sqlite/sync-database'
import { isProfileStateSplitDomain } from './profile-state-document-parts'
import { readProfileStateSplitDocument } from './profile-state-document-parts-storage'
import {
  isRecord,
  ProfileStateDocumentCorruptionError,
  type ProfileStateDocument
} from './profile-state-document-validation'

/** The reassembled document when this legacy row's domain is stored as parts. */
export function readProfileStateSplitDocumentForRow(
  db: Database.Database,
  row: unknown,
  retainParsedValue: boolean
): (ProfileStateDocument & { value?: unknown }) | undefined {
  if (
    !isRecord(row) ||
    typeof row.domain !== 'string' ||
    !isProfileStateSplitDomain(row.domain) ||
    !Number.isSafeInteger(row.revision)
  ) {
    return undefined
  }
  const document = readProfileStateSplitDocument(db, row.domain, row.revision as number)
  if (!document || !retainParsedValue) {
    return document
  }
  try {
    return { ...document, value: JSON.parse(document.payload) }
  } catch {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document parts are invalid JSON: ${row.domain}`,
      row.domain
    )
  }
}
