import { createHash } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import type {
  SurfaceHostDomain,
  SurfaceProfileDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import {
  surfaceEvidenceDocumentSchema,
  isSurfaceEvidenceDomain,
  surfaceEvidenceKey,
  surfaceEvidenceScope,
  surfaceMappingPrefix,
  type SurfaceEvidenceDocument
} from '../../shared/workspace-surfaces/surface-evidence-document'
import { validateProfileStateDocumentRow } from '../persistence/profile-state/profile-state-document-validation'
import type { ProfileStateDomainMutation } from '../persistence/profile-state/profile-state-domain-writes'
import {
  readSurfaceMappingBucket,
  registerSurfaceMappingReader,
  type SurfaceMappingBucket
} from './surface-migration-identities'

type MappingDocument = Extract<SurfaceEvidenceDocument, { kind: 'mapping' }>

function documentMappingBuckets(documents: object): Map<string, MappingDocument[]> {
  const buckets = new Map<string, MappingDocument[]>()
  for (const [key, value] of Object.entries(documents)) {
    if (!isSurfaceEvidenceDomain(key)) {
      continue
    }
    const document = surfaceEvidenceDocumentSchema.parse(value)
    if (document.kind !== 'mapping') {
      continue
    }
    const prefix = surfaceMappingPrefix(
      document.hostId,
      document.value.workspaceId,
      document.value.kind,
      document.value.previousId
    )
    const bucket = buckets.get(prefix)
    if (bucket) {
      bucket.push(document)
    } else {
      buckets.set(prefix, [document])
    }
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => left.sequence - right.sequence)
  }
  return buckets
}

/** Offline owners use the same ordered buckets before choosing imported identities. */
export function surfaceDocumentMappingBuckets(
  documents: object
): Map<string, SurfaceMappingBucket> {
  return new Map(
    [...documentMappingBuckets(documents)].map(([prefix, entries]) => [
      prefix,
      {
        entries: entries.map((entry) => entry.value),
        nextSequence: entries.at(-1)!.sequence + 1
      }
    ])
  )
}

/** A restored lineage appends distinct mappings after the selected lineage, preserving both orders. */
export function mergeSurfaceEvidenceDocuments(
  target: object,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const held = surfaceDocumentMappingBuckets(target)
  for (const [key, value] of Object.entries(incoming)) {
    const document = surfaceEvidenceDocumentSchema.parse(value)
    if (document.kind === 'mapping') {
      continue
    }
    const previous: unknown = Object.getOwnPropertyDescriptor(target, key)?.value
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
      throw new Error('Conflicting surface evidence document')
    }
    result[key] = value
  }
  for (const [prefix, documents] of documentMappingBuckets(incoming)) {
    const previous = held.get(prefix)
    const known = new Set(previous?.entries.map((entry) => JSON.stringify(entry)))
    let sequence = previous?.nextSequence ?? 0
    for (const document of documents) {
      const encoded = JSON.stringify(document.value)
      if (known.has(encoded)) {
        continue
      }
      const next = previous ? { ...document, sequence: sequence++ } : document
      if (!Number.isSafeInteger(next.sequence)) {
        throw new Error('Surface mapping sequence is exhausted')
      }
      result[surfaceEvidenceKey(next, () => '')] = next
      known.add(encoded)
    }
  }
  return result
}

/** Only a collision's exact mapping bucket is read; warm content commands never read history. */
export function attachSurfaceEvidenceReader(
  db: Database.Database,
  hostId: string,
  host: SurfaceHostDomain
): void {
  registerSurfaceMappingReader(host, (workspaceId, kind, previousId) => {
    const prefix = surfaceMappingPrefix(hostId, workspaceId, kind, previousId)
    const documents = db
      .prepare(`SELECT domain, payload, domain_version, revision, updated_at, content_hash
      FROM main.profile_state_documents WHERE domain >= ? AND domain < ? ORDER BY domain`)
      .all(prefix, `${prefix}\uffff`)
      .map((row) => {
        const document = validateProfileStateDocumentRow(row, { retainParsedValue: true })
        const value = surfaceEvidenceDocumentSchema.parse(document.value)
        if (
          value.kind !== 'mapping' ||
          value.hostId !== hostId ||
          value.value.workspaceId !== workspaceId ||
          value.value.kind !== kind ||
          value.value.previousId !== previousId
        ) {
          throw new Error('Surface mapping document identity is inconsistent')
        }
        return value
      })
      .sort((a, b) => a.sequence - b.sequence)
    return {
      entries: documents.map((entry) => entry.value),
      nextSequence: (documents.at(-1)?.sequence ?? -1) + 1
    }
  })
}

/** Old hot evidence is removed only in the transaction that preserves its individual documents. */
export function extractSurfaceEvidenceDocuments(
  db: Database.Database,
  domain: SurfaceProfileDomain
): ProfileStateDomainMutation[] {
  return prepareSurfaceEvidenceDocuments(domain, (hostId, host) =>
    attachSurfaceEvidenceReader(db, hostId, host)
  )
}

export function prepareSurfaceEvidenceDocuments(
  domain: SurfaceProfileDomain,
  attach: (hostId: string, host: SurfaceHostDomain) => void
): ProfileStateDomainMutation[] {
  const mutations = new Map<string, ProfileStateDomainMutation>()
  for (const [hostId, host] of Object.entries(domain.hosts)) {
    for (const reference of host.retainedReferences) {
      const payload = JSON.stringify({ version: 1, hostId, kind: 'reference', value: reference })
      const hash = createHash('sha256').update(payload).digest('hex')
      const key = `${surfaceEvidenceScope(hostId, reference.workspaceId)}reference/${hash}`
      mutations.set(key, { domain: key, payload })
    }
    const buckets = new Map<string, { hashes: Set<string>; nextSequence: number }>()
    for (const mapping of host.identityMappings) {
      const prefix = surfaceMappingPrefix(
        hostId,
        mapping.workspaceId,
        mapping.kind,
        mapping.previousId
      )
      let entries = buckets.get(prefix)
      if (!entries) {
        attach(hostId, host)
        const stored = readSurfaceMappingBucket(
          host,
          mapping.workspaceId,
          mapping.kind,
          mapping.previousId
        )
        entries = {
          hashes: new Set(stored.entries.map((entry) => JSON.stringify(entry))),
          nextSequence: stored.nextSequence
        }
        buckets.set(prefix, entries)
      }
      const encoded = JSON.stringify(mapping)
      if (entries.hashes.has(encoded)) {
        continue
      }
      const sequence = entries.nextSequence++
      if (!Number.isSafeInteger(sequence)) {
        throw new Error('Surface mapping sequence is exhausted')
      }
      const key = `${prefix}${String(sequence).padStart(16, '0')}`
      mutations.set(key, {
        domain: key,
        payload: JSON.stringify({ version: 1, hostId, kind: 'mapping', sequence, value: mapping })
      })
      entries.hashes.add(encoded)
    }
    host.retainedReferences = []
    host.identityMappings = []
  }
  return [...mutations.values()]
}
