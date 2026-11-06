/** Match OpenSSH10.2p1's measured trust behavior, especially ordered lookup passes and global revocation precedence. */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Ordered by severity: the first one that applies decides. */
export type KnownHostsOutcome =
  | 'match'
  | 'mismatch'
  | 'revoked'
  | 'ca-only'
  | 'unknown-type-known-host'
  | 'unknown'

export type KnownHostsEntry = {
  /** `@revoked` / `@cert-authority`; a line with any other marker is dropped at parse time. */
  marker?: 'revoked' | 'cert-authority'
  /** Literal or glob host patterns, lower-cased. Empty when the line is hashed. */
  patterns: string[]
  /** Present only for `|1|salt|hash` lines. */
  hashed?: { salt: Buffer; hash: Buffer }
  /** Whether any pattern on the line is a `!negation`. One negated match vetoes the whole line. */
  negations: string[]
  keyType: string
  key: Buffer
}

const HASH_MAGIC = '|1|'
const SHA1_DIGEST_BYTES = 20
/** Guards a malformed length prefix from allocating or reading past the blob. */
const MAX_KEY_TYPE_BYTES = 64

/** Read the blob's algorithm so mismatched declared line types cannot grant trust. */
export function readHostKeyType(key: Buffer): string | undefined {
  if (key.length < 4) {
    return undefined
  }
  const length = key.readUInt32BE(0)
  if (length === 0 || length > MAX_KEY_TYPE_BYTES || 4 + length > key.length) {
    return undefined
  }
  return key.subarray(4, 4 + length).toString('utf8')
}

/** Consume the whole length-prefixed wire structure for every algorithm; OpenSSH drops blobs with trailing bytes even when base64 and the type header are valid. */
function isWellFormedHostKeyBlob(key: Buffer): boolean {
  let offset = 0
  while (offset < key.length) {
    if (offset + 4 > key.length) {
      return false
    }
    const fieldLength = key.readUInt32BE(offset)
    offset += 4
    if (fieldLength > key.length - offset) {
      return false
    }
    offset += fieldLength
  }
  return offset === key.length
}

/** `SHA256:...` exactly as `ssh-keygen -lf` prints it, base64 with padding stripped. */
export function formatHostKeyFingerprint(sha256Base64: string): string {
  return `SHA256:${sha256Base64.replace(/=+$/, '')}`
}

/** Require exact canonical base64, including padding and zero leftover bits. Buffer.from skips junk and accepts forms OpenSSH10.2p1 rejects, which could grant trust or falsely report changed keys. */
function decodeCanonicalBase64(raw: string): Buffer | undefined {
  const decoded = Buffer.from(raw, 'base64')
  // Empty would re-encode to '' and pass the comparison; `|1||hash` must not survive as an entry.
  if (decoded.length === 0) {
    return undefined
  }
  return decoded.toString('base64') === raw ? decoded : undefined
}

function parseHashedPatterns(field: string): KnownHostsEntry['hashed'] | undefined {
  const parts = field.split('|')
  // '' , '1', salt, hash — exactly four, or the line is malformed.
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== '1') {
    return undefined
  }
  const salt = decodeCanonicalBase64(parts[2] ?? '')
  const hash = decodeCanonicalBase64(parts[3] ?? '')
  // Both canonical salt and hash must be exactly20 bytes, matching OpenSSH extract_salt.
  if (!salt || !hash || salt.length !== SHA1_DIGEST_BYTES || hash.length !== SHA1_DIGEST_BYTES) {
    return undefined
  }
  return { salt, hash }
}

/** Returns undefined for blank lines, comments, and anything malformed — never throws. */
export function parseKnownHostsLine(line: string): KnownHostsEntry | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return undefined
  }

  const fields = trimmed.split(/\s+/)
  let index = 0
  let marker: KnownHostsEntry['marker']
  if (fields[index]?.startsWith('@')) {
    const raw = fields[index]
    if (raw === '@revoked') {
      marker = 'revoked'
    } else if (raw === '@cert-authority') {
      marker = 'cert-authority'
    } else {
      // Unknown markers may restrict trust; never honor them as unmarked lines.
      return undefined
    }
    index += 1
  }

  const hostField = fields[index]
  const keyType = fields[index + 1]
  const keyBase64 = fields[index + 2]
  if (!hostField || !keyType || !keyBase64) {
    return undefined
  }

  const key = decodeCanonicalBase64(keyBase64)
  if (!key || readHostKeyType(key) !== keyType || !isWellFormedHostKeyBlob(key)) {
    return undefined
  }

  if (hostField.startsWith(HASH_MAGIC)) {
    const hashed = parseHashedPatterns(hostField)
    return hashed
      ? { ...(marker ? { marker } : {}), patterns: [], negations: [], hashed, keyType, key }
      : undefined
  }

  const patterns: string[] = []
  const negations: string[] = []
  for (const raw of hostField.split(',')) {
    const pattern = raw.trim().toLowerCase()
    if (pattern.length === 0) {
      continue
    }
    if (pattern.startsWith('!')) {
      negations.push(pattern.slice(1))
    } else {
      patterns.push(pattern)
    }
  }
  if (patterns.length === 0 && negations.length === 0) {
    return undefined
  }
  return { ...(marker ? { marker } : {}), patterns, negations, keyType, key }
}

export function parseKnownHosts(contents: string): KnownHostsEntry[] {
  const entries: KnownHostsEntry[] = []
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseKnownHostsLine(line)
    if (entry) {
      entries.push(entry)
    }
  }
  return entries
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

function patternMatches(pattern: string, candidate: string): boolean {
  return pattern.includes('*') || pattern.includes('?')
    ? globToRegExp(pattern).test(candidate)
    : pattern === candidate
}

function entryMatchesCandidate(entry: KnownHostsEntry, candidate: string): boolean {
  if (entry.hashed) {
    // Hash each candidate verbatim, including port brackets.
    const digest = createHmac('sha1', entry.hashed.salt).update(candidate).digest()
    return digest.length === entry.hashed.hash.length && timingSafeEqual(digest, entry.hashed.hash)
  }
  // A single negation vetoes the entire line even when another pattern on it matches.
  if (entry.negations.some((pattern) => patternMatches(pattern, candidate))) {
    return false
  }
  return entry.patterns.some((pattern) => patternMatches(pattern, candidate))
}

/** Try port-qualified then bare host; any plain first-pass entry decides. HostKeyAlias skips port qualification entirely, as measured against OpenSSH10.2p1. */
export function hostCandidatePasses(
  host: string,
  port: number,
  isHostKeyAlias = false
): string[][] {
  const lower = host.toLowerCase()
  return port === 22 || isHostKeyAlias ? [[lower]] : [[`[${lower}]:${port}`], [lower]]
}

export type KnownHostsQuery = {
  host: string
  port: number
  keyType: string
  key: Buffer
  /** True when `host` came from `HostKeyAlias`, which ssh looks up without the port. */
  isHostKeyAlias?: boolean
}

/** Union caller-supplied files: an exact key hit wins over disagreeing entries elsewhere. */
export function matchKnownHosts(
  entries: readonly KnownHostsEntry[],
  query: KnownHostsQuery
): KnownHostsOutcome {
  const passes = hostCandidatePasses(query.host, query.port, query.isHostKeyAlias)
  const matchesHost = (entry: KnownHostsEntry, candidates: string[]): boolean =>
    candidates.some((candidate) => entryMatchesCandidate(entry, candidate))

  // Revocation resolves first, across every pass, so the verdict cannot depend on line order.
  for (const candidates of passes) {
    for (const entry of entries) {
      if (
        entry.marker === 'revoked' &&
        matchesHost(entry, candidates) &&
        entry.key.equals(query.key)
      ) {
        return 'revoked'
      }
    }
  }

  // CA markers neither satisfy plain keys nor stop bare fallback; retain their presence across passes.
  let sawCertAuthority = false

  for (let passIndex = 0; passIndex < passes.length; passIndex += 1) {
    const candidates = passes[passIndex]!
    // Scope change evidence to this pass; fallback evidence cannot imply a changed key.
    let sawSameTypeForHost = false
    let sawPlainEntryForHost = false

    for (const entry of entries) {
      if (entry.marker === 'revoked' || !matchesHost(entry, candidates)) {
        continue
      }
      if (entry.marker === 'cert-authority') {
        sawCertAuthority = true
        continue
      }
      // The blob carries its algorithm; parsing already required the declared type to agree.
      if (entry.key.equals(query.key)) {
        return 'match'
      }
      sawPlainEntryForHost = true
      sawSameTypeForHost ||= entry.keyType === query.keyType
    }

    // Any plain entry in pass0 blocks fallback, even another key type; continuing could accept a changed endpoint key (OpenSSH10.2p1).
    if (passIndex === 0 && sawPlainEntryForHost) {
      // Both refuse as HOST_CHANGED; distinguish same-type mismatch only for messaging.
      return sawSameTypeForHost ? 'mismatch' : 'unknown-type-known-host'
    }
  }

  // Fallback nonmatches are first contact in OpenSSH10.2p1, never change evidence.
  return sawCertAuthority ? 'ca-only' : 'unknown'
}
