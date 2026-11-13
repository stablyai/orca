import type Database from '../../../sqlite/sync-database'
import {
  isProfileStateSplitDomain,
  PROFILE_STATE_SPLIT_DOMAIN_DEPTHS
} from './profile-state-document-parts'
import { readProfileStateSplitDocument, safeInteger } from './profile-state-document-parts-storage'
import {
  isRecord,
  ProfileStateDocumentCorruptionError,
  validateProfileStateDocumentRow,
  type ProfileStateDocument
} from '../documents/profile-state-document-validation'

const SPLIT_DOMAIN_LIST = [...PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.keys()]
  .map((domain) => `'${domain}'`)
  .join(',')

/**
 * Document row columns that skip the legacy payload of split domains: their parts are
 * usually authoritative, and that payload can be megabytes.
 */
export const PROFILE_STATE_DOCUMENT_ROW_COLUMNS = `domain,
  CASE WHEN domain IN (${SPLIT_DOMAIN_LIST}) THEN NULL ELSE payload END AS payload,
  domain_version, revision, updated_at, content_hash`

/** Validated document for a row selected with PROFILE_STATE_DOCUMENT_ROW_COLUMNS. */
export function readProfileStateDocumentRow(
  db: Database.Database,
  row: unknown,
  retainParsedValue: boolean
): ProfileStateDocument & { value?: unknown } {
  return (
    readProfileStateSplitDocumentForRow(db, row, retainParsedValue) ??
    validateProfileStateDocumentRow(withLegacyPayload(db, row), { retainParsedValue })
  )
}

// Runs inside the caller's open statement, so it reads the same snapshot.
function withLegacyPayload(db: Database.Database, row: unknown): unknown {
  if (!isRecord(row) || row.payload !== null || typeof row.domain !== 'string') {
    return row
  }
  const legacy: unknown = db
    .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
    .get(row.domain)
  return { ...row, payload: isRecord(legacy) ? legacy.payload : null }
}

/** The reassembled document when this legacy row's domain is stored as parts. */
export function readProfileStateSplitDocumentForRow(
  db: Database.Database,
  row: unknown,
  retainParsedValue: boolean
): (ProfileStateDocument & { value?: unknown }) | undefined {
  const revision = isRecord(row) ? safeInteger(row.revision) : undefined
  if (
    !isRecord(row) ||
    typeof row.domain !== 'string' ||
    !isProfileStateSplitDomain(row.domain) ||
    revision === undefined
  ) {
    return undefined
  }
  const document = readProfileStateSplitDocument(db, row.domain, revision)
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
