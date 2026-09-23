import { withProfileStateReadSnapshot } from './profile-state-read-snapshot'
import {
  assertProfileStateDocumentRevision,
  readProfileStateRevision
} from './profile-state-revision'
import { readProfileStateAutomationRunsDocument } from './profile-state-automation-runs'
import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import {
  validateProfileStateDocumentRow,
  type ProfileStateDocument
} from './profile-state-document-validation'

export type ProfileStateDomainReadResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: unknown }

export type ProfileStateDomainsReadResult =
  | { kind: 'values'; revision: number; values: ReadonlyMap<string, unknown> }
  | { kind: 'unreadable'; error: unknown }

/**
 * Read one domain from an existing profile database without opening a write
 * handle, applying migrations, or creating the database. Any malformed selected
 * row makes the whole read unusable so callers that prune state can fail closed.
 */
export function readProfileStateDomain(
  databasePath: string,
  profileId: string,
  domain: string
): ProfileStateDomainReadResult {
  const result = readProfileStateDomains(databasePath, profileId, [domain])
  if (result.kind === 'unreadable') {
    return result
  }
  if (!result.values.has(domain)) {
    return { kind: 'missing' }
  }
  return { kind: 'value', value: result.values.get(domain) }
}

/** Read several domains and the fencing revision under one SQLite snapshot. */
export function readProfileStateDomains(
  databasePath: string,
  profileId: string,
  domains: readonly string[]
): ProfileStateDomainsReadResult {
  let opened: ReturnType<typeof openProfileStateDatabaseReadOnly> | undefined
  try {
    opened = openProfileStateDatabaseReadOnly(databasePath, profileId)
    return readProfileStateDomainsWithRevisionFromDatabase(opened.db, domains)
  } catch (error) {
    return { kind: 'unreadable', error }
  } finally {
    opened?.db.close()
  }
}

/** Read several domains from an already-open database, keeping the caller's handle alive. */
export function readProfileStateDomainsWithRevisionFromDatabase(
  db: Parameters<typeof readProfileStateRevision>[0],
  domains: readonly string[]
): ProfileStateDomainsReadResult {
  const wanted = new Set(domains)
  const values = new Map<string, unknown>()
  try {
    return withProfileStateReadSnapshot(db, () => {
      const revision = readProfileStateRevision(db)
      if (wanted.size === 0) {
        return { kind: 'values', revision, values }
      }

      const normalized = wanted.has('automationRuns')
        ? readProfileStateAutomationRunsDocument(db, revision)
        : undefined
      const legacyDomains = [...wanted].filter(
        (domain) => domain !== 'automationRuns' || normalized === undefined
      )
      for (const document of readSelectedDocuments(db, legacyDomains)) {
        assertProfileStateDocumentRevision(document.revision, revision, document.domain)
        values.set(document.domain, JSON.parse(document.payload))
      }
      if (normalized !== undefined && normalized !== null) {
        values.set(normalized.domain, JSON.parse(normalized.payload))
      }
      return { kind: 'values', revision, values }
    })
  } catch (error) {
    return { kind: 'unreadable', error }
  }
}

function readSelectedDocuments(
  db: Parameters<typeof readProfileStateRevision>[0],
  domains: readonly string[]
): readonly ProfileStateDocument[] {
  if (domains.length === 0) {
    return []
  }
  const placeholders = domains.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT domain, payload, domain_version, revision, updated_at, content_hash
       FROM profile_state_documents
       WHERE domain IN (${placeholders})
       ORDER BY rowid`
    )
    .all(...domains)
  return rows.map((row) => validateProfileStateDocumentRow(row))
}
