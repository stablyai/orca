import { hashProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import {
  isRecord,
  type ProfileStateParsedDocument
} from '../persistence/profile-state/profile-state-document-validation'
import { prepareProfileStateDomainMutation } from '../persistence/profile-state/profile-state-domain-write-validation'
import type { ProfileStateDomainMutation } from '../persistence/profile-state/profile-state-domain-writes'
import type { PersistedState } from '../../shared/persisted-state-types'

export type ProfileProjectDomainDigest = { domain: string; hash: string }

export type ProfileProjectDomainChanges = {
  expectedRevision: number
  before: ProfileProjectDomainDigest[]
  afterHash: string
  replacements: { domain: string; payload: string | null }[]
}

export function profileProjectDomainFingerprint(
  domains: readonly ProfileProjectDomainDigest[]
): string {
  const pairs = domains.map(({ domain, hash }) => [domain, hash])
  pairs.sort(([left = ''], [right = '']) => (left < right ? -1 : left > right ? 1 : 0))
  return hashProfileStateJson(`orca-profile-move-domains-v2:${JSON.stringify(pairs)}`)
}

export function profileProjectDomainDigests(
  documents: readonly ProfileStateParsedDocument[]
): ProfileProjectDomainDigest[] {
  return documents.map(({ domain, contentHash }) => ({ domain, hash: contentHash }))
}

export function prepareProfileProjectDomainChanges(
  revision: number,
  documents: readonly ProfileStateParsedDocument[],
  state: PersistedState
): ProfileProjectDomainChanges {
  const originals = new Map(documents.map((document) => [document.domain, document]))
  const replacements: ProfileProjectDomainChanges['replacements'] = []
  for (const [domain, value] of Object.entries(state)) {
    const original = originals.get(domain)
    // Transfer projections retain unchanged values; do not serialize unrelated history/output.
    if (original && Object.is(original.value, value)) {
      continue
    }
    const payload = JSON.stringify(value) ?? null
    if (
      payload === null
        ? original !== undefined
        : hashProfileStateJson(payload) !== original?.contentHash
    ) {
      replacements.push({ domain, payload })
    }
  }
  for (const domain of originals.keys()) {
    if (!Object.hasOwn(state, domain)) {
      replacements.push({ domain, payload: null })
    }
  }
  const before = profileProjectDomainDigests(documents)
  return {
    expectedRevision: revision,
    before,
    afterHash: profileProjectDomainFingerprint(applyDomainDigests(before, replacements)),
    replacements
  }
}

function applyDomainDigests(
  before: readonly ProfileProjectDomainDigest[],
  replacements: readonly ProfileStateDomainMutation[]
): ProfileProjectDomainDigest[] {
  const digests = new Map(before.map(({ domain, hash }) => [domain, hash]))
  for (const { domain, payload } of replacements) {
    if (payload === null) {
      digests.delete(domain)
    } else {
      digests.set(domain, hashProfileStateJson(payload))
    }
  }
  return [...digests].map(([domain, hash]) => ({ domain, hash }))
}

export function validateProfileProjectDomainChanges(
  value: unknown
): asserts value is ProfileProjectDomainChanges {
  if (
    !isRecord(value) ||
    typeof value.expectedRevision !== 'number' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !Number.isSafeInteger(value.expectedRevision + 1) ||
    !Array.isArray(value.before) ||
    !Array.isArray(value.replacements) ||
    value.replacements.length === 0 ||
    !isHash(value.afterHash)
  ) {
    throw new Error('Profile move domain changes are malformed')
  }
  const before: ProfileProjectDomainDigest[] = []
  const domains = new Set<string>()
  for (const digest of value.before) {
    if (
      !isRecord(digest) ||
      typeof digest.domain !== 'string' ||
      !isHash(digest.hash) ||
      domains.has(digest.domain)
    ) {
      throw new Error('Profile move domain manifest is malformed')
    }
    domains.add(digest.domain)
    before.push({ domain: digest.domain, hash: digest.hash })
  }
  const replacements: ProfileStateDomainMutation[] = []
  domains.clear()
  for (const replacement of value.replacements) {
    if (
      !isRecord(replacement) ||
      !isDomain(replacement.domain) ||
      (replacement.payload !== null && typeof replacement.payload !== 'string') ||
      domains.has(replacement.domain)
    ) {
      throw new Error('Profile move domain replacement is malformed')
    }
    domains.add(replacement.domain)
    const mutation = { domain: replacement.domain, payload: replacement.payload }
    prepareProfileStateDomainMutation(mutation)
    replacements.push(mutation)
  }
  if (
    profileProjectDomainFingerprint(applyDomainDigests(before, replacements)) !== value.afterHash ||
    profileProjectDomainFingerprint(before) === value.afterHash
  ) {
    throw new Error('Profile move domain changes do not match their fingerprint')
  }
}

function isDomain(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
