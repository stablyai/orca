import type Database from '../../sqlite/sync-database'
import type { ProfileStateDomainPartsUpdate } from '../loading-store/profile-state-authority'
import type { PreparedProfileStateMutation } from './profile-state-domain-write-validation'
import {
  assembleProfileStateDomainPayload,
  splitProfileStateDomainValue,
  PROFILE_STATE_DOCUMENT_PARTS_TABLE,
  type ProfileStateDocumentPart
} from './profile-state-document-parts'
import { readSplitDomainWriteState } from './profile-state-document-parts-storage'
import {
  hashProfileStatePayload,
  isRecord,
  ProfileStateDocumentCorruptionError,
  validateProfileStateDocumentRow
} from './profile-state-document-validation'
import { assertProfileStateDocumentRevision } from './profile-state-revision'

export function prepareProfileStateDomainPartsUpdate(
  db: Database.Database,
  update: ProfileStateDomainPartsUpdate,
  revision: number
): PreparedProfileStateMutation {
  const split = readSplitDomainWriteState(db, update.domain)
  let previous: ProfileStateDocumentPart[] = []
  if (split.kind === 'parts') {
    assertProfileStateDocumentRevision(split.revision, revision, update.domain)
    previous = db
      .prepare(
        `SELECT part_key, payload FROM ${PROFILE_STATE_DOCUMENT_PARTS_TABLE} WHERE domain = ? ORDER BY ordinal`
      )
      .all(update.domain)
      .map((row) => {
        if (!isRecord(row) || typeof row.part_key !== 'string' || typeof row.payload !== 'string') {
          throw new ProfileStateDocumentCorruptionError(
            'Profile state delta base is invalid',
            update.domain
          )
        }
        return { key: row.part_key, payload: row.payload }
      })
    if (
      hashProfileStatePayload(assembleProfileStateDomainPayload(previous)) !== split.contentHash
    ) {
      throw new ProfileStateDocumentCorruptionError(
        'Profile state delta base hash mismatch',
        update.domain
      )
    }
  } else {
    const row = db
      .prepare(
        'SELECT domain, payload, domain_version, revision, updated_at, content_hash FROM profile_state_documents WHERE domain = ?'
      )
      .get(update.domain)
    if (row !== undefined) {
      const document = validateProfileStateDocumentRow(row)
      assertProfileStateDocumentRevision(document.revision, revision, update.domain)
      previous = splitProfileStateDomainValue(JSON.parse(document.payload), 3)
    }
  }
  const payloads = new Map(previous.map((part) => [part.key, part.payload]))
  const keys = new Set(update.order)
  if (keys.size !== update.order.length || keys.size === 0) {
    throw new Error('Invalid profile state part order')
  }
  const changed = new Set<string>()
  for (const part of update.parts) {
    if (!keys.has(part.key) || changed.has(part.key)) {
      throw new Error('Invalid profile state changed part')
    }
    JSON.parse(part.payload)
    payloads.set(part.key, part.payload)
    changed.add(part.key)
  }
  const closed = new Set<string>()
  const empty = new Set<string>()
  let environment: string | undefined
  let hasPartInEnvironment = false
  const parts = update.order.map((key) => {
    const path: unknown = JSON.parse(key)
    if (
      !Array.isArray(path) ||
      !path.every((segment) => typeof segment === 'string') ||
      JSON.stringify(path) !== key ||
      !(path.length === 0 || ((path.length === 2 || path.length === 3) && path[1] === 'workspaces'))
    ) {
      throw new Error('Invalid remote layout snapshot part key')
    }
    const payload = payloads.get(key)
    if (payload === undefined) {
      throw new Error('Missing profile state part')
    }
    if (path.length === 0) {
      if (keys.size !== 1 || payload !== '{}') {
        throw new Error('Invalid empty remote layout snapshot')
      }
    } else {
      if (environment !== path[0]) {
        if (environment !== undefined) {
          closed.add(environment)
        }
        if (closed.has(path[0])) {
          throw new Error('Repeated remote layout snapshot environment')
        }
        environment = path[0]
        hasPartInEnvironment = false
      }
      if (empty.has(environment!)) {
        throw new Error('Overlapping remote layout snapshot parts')
      }
      if (path.length === 2) {
        if (payload !== '{}' || hasPartInEnvironment) {
          throw new Error('Invalid empty remote layout workspaces')
        }
        empty.add(environment!)
      }
      hasPartInEnvironment = true
    }
    return { key, payload }
  })
  const payload = assembleProfileStateDomainPayload(parts)
  return {
    domain: update.domain,
    payload,
    payloadHash: hashProfileStatePayload(payload),
    domainVersion: 1,
    serializedParts: parts,
    changedPartKeys: changed
  }
}
