import {
  isSurfaceEvidenceDomain,
  SURFACE_EVIDENCE_PREFIX,
  surfaceEvidenceDocumentSchema
} from '../../shared/workspace-surfaces/surface-evidence-document'
import { validateProfileStateDocumentRow } from '../persistence/profile-state/profile-state-document-validation'
import { existsSync, readFileSync } from 'node:fs'
import { createJsonTokenReader } from '../../shared/json-token-reader'
import {
  WORKSPACE_SURFACE_DOMAIN,
  surfaceProfileDomainSchema,
  type SurfaceProfileDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { readProfileStateDomainsWithRevisionFromDatabase } from '../persistence/profile-state/profile-state-domain-reader'
import type Database from '../sqlite/sync-database'

export function readSurfaceSqlEvidenceDocuments(db: Database.Database): Record<string, unknown> {
  const documents: Record<string, unknown> = {}
  for (const row of db
    .prepare(`SELECT domain, payload, domain_version, revision, updated_at, content_hash
      FROM main.profile_state_documents WHERE domain >= ? AND domain < ? ORDER BY domain`)
    .all(SURFACE_EVIDENCE_PREFIX, `${SURFACE_EVIDENCE_PREFIX}\uffff`)) {
    const document = validateProfileStateDocumentRow(row, { retainParsedValue: true })
    documents[document.domain] = surfaceEvidenceDocumentSchema.parse(document.value)
  }
  return documents
}

export type SurfaceRecoveryEvidence =
  | { kind: 'value'; carrier?: SurfaceProfileDomain; documents: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: unknown }

/** Maintenance owns the original paths, so SQLite can recover its actual attached rollback family. */
export function readSurfaceSqlRecoveryEvidence(
  databasePath: string,
  profileId: string
): SurfaceRecoveryEvidence {
  if (!existsSync(databasePath)) {
    return { kind: 'missing' }
  }
  let opened: ReturnType<typeof openProfileStateDatabase> | undefined
  try {
    opened = openProfileStateDatabase(databasePath, profileId)
    if (opened.readOnly) {
      throw new Error('Profile surface recovery requires a supported database')
    }
    const result = readProfileStateDomainsWithRevisionFromDatabase(opened.db, [
      WORKSPACE_SURFACE_DOMAIN
    ])
    if (result.kind === 'unreadable') {
      return result
    }
    const carrier = result.values.get(WORKSPACE_SURFACE_DOMAIN)
    const documents = readSurfaceSqlEvidenceDocuments(opened.db)
    return carrier === undefined && !Object.keys(documents).length
      ? { kind: 'missing' }
      : {
          kind: 'value',
          carrier: carrier === undefined ? undefined : surfaceProfileDomainSchema.parse(carrier),
          documents
        }
  } catch (error) {
    return { kind: 'unreadable', error }
  } finally {
    opened?.db.close()
  }
}

export function readSurfaceJsonRecoveryEvidence(dataFile: string): SurfaceRecoveryEvidence {
  if (!existsSync(dataFile)) {
    return { kind: 'missing' }
  }
  try {
    const documents = surfaceDocumentsFromRecoveryJson(readFileSync(dataFile, 'utf8'))
    const carrier = documents[WORKSPACE_SURFACE_DOMAIN]
    delete documents[WORKSPACE_SURFACE_DOMAIN]
    return carrier === undefined && !Object.keys(documents).length
      ? { kind: 'missing' }
      : {
          kind: 'value',
          carrier: carrier === undefined ? undefined : surfaceProfileDomainSchema.parse(carrier),
          documents
        }
  } catch (error) {
    return { kind: 'unreadable', error }
  }
}

/** Unrelated history strings never accumulate in the selected recovery documents. */
export function surfaceCarrierFromRecoveryJson(rawJson: string): SurfaceProfileDomain | undefined {
  const carrier = surfaceDocumentsFromRecoveryJson(rawJson)[WORKSPACE_SURFACE_DOMAIN]
  return carrier === undefined ? undefined : surfaceProfileDomainSchema.parse(carrier)
}

export function surfaceDocumentsFromRecoveryJson(rawJson: string): Record<string, unknown> {
  type Frame = { value: unknown[] | Record<string, unknown>; key?: string }
  const frames: Frame[] = []
  let rootSeen = false
  let depth = 0
  let rootKey: string | undefined
  let value: unknown
  const documents: Record<string, unknown> = {}
  const selectedKey = () =>
    rootKey === WORKSPACE_SURFACE_DOMAIN ||
    (rootKey !== undefined && isSurfaceEvidenceDomain(rootKey))
  const append = (next: unknown) => {
    const parent = frames.at(-1)
    if (!parent) {
      value = next
    } else if (Array.isArray(parent.value)) {
      parent.value.push(next)
    } else if (parent.key !== undefined) {
      Object.defineProperty(parent.value, parent.key, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true
      })
      parent.key = undefined
    }
  }
  const reader = createJsonTokenReader(
    (token) => {
      if (!rootSeen) {
        if (token.name !== 'startObject') {
          throw new Error('Profile recovery JSON root must be an object')
        }
        rootSeen = true
      }
      if (token.name === 'keyValue') {
        if (depth === 1) {
          rootKey = token.value
        } else {
          const frame = frames.at(-1)
          if (frame) {
            frame.key = token.value
          }
        }
        return
      }
      const selected = depth >= 1 && selectedKey()
      if (token.name === 'startObject' || token.name === 'startArray') {
        if (selected) {
          const nested = token.name === 'startArray' ? [] : {}
          append(nested)
          frames.push({ value: nested })
        }
        depth++
      } else if (token.name === 'endObject' || token.name === 'endArray') {
        if (selected) {
          frames.pop()
        }
        depth--
        if (selected && depth === 1 && rootKey) {
          documents[rootKey] = value
          value = undefined
        }
      } else if (selected) {
        if (token.name === 'stringValue') {
          append(token.value)
        } else if (token.name === 'numberValue') {
          append(Number(token.value))
        } else if (token.name === 'trueValue') {
          append(true)
        } else if (token.name === 'falseValue') {
          append(false)
        } else if (token.name === 'nullValue') {
          append(null)
        }
        if (depth === 1 && rootKey) {
          documents[rootKey] = value
          value = undefined
        }
      }
    },
    64 * 1024,
    () => depth >= 1 && selectedKey()
  )
  reader.write(rawJson)
  reader.end()
  for (const [key, value] of Object.entries(documents)) {
    documents[key] =
      key === WORKSPACE_SURFACE_DOMAIN
        ? surfaceProfileDomainSchema.parse(value)
        : surfaceEvidenceDocumentSchema.parse(value)
  }
  return documents
}
