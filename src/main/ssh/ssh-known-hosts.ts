/**
 * OpenSSH `known_hosts` parsing and matching.
 *
 * Hand-rolled because no maintained JS implementation exists. Behaviour was verified against
 * OpenSSH 10.2p1 rather than inferred from the man page — the two lookup passes and the
 * revoked-wins rule in particular are observable behaviours that a reasonable reading of the docs
 * gets wrong. See docs/reference/ssh-host-key-verification.md.
 */
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

/**
 * Read the algorithm name from the key blob's own length-prefixed header.
 *
 * Why not trust the line's type field: the two must agree, and comparing them is what rejects a
 * line that claims one algorithm while carrying another.
 */
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

/**
 * Whether the blob is exactly consumed by its own SSH-wire structure.
 *
 * A public key blob is a run of length-prefixed fields — name, then the algorithm's parameters — and
 * nothing else. Checking only the algorithm header leaves trailing bytes undetected, and ssh parses
 * the whole structure: verified live against OpenSSH 10.2p1, a valid ed25519 key with four extra
 * base64 characters appended is still valid base64 and still reports `ssh-ed25519`, but ssh reports
 * "No ED25519 host key is known" and drops the line, where we decoded 54 bytes instead of 51 and
 * raised a CHANGED alarm from an entry the user's own ssh ignores.
 *
 * Deliberately algorithm-agnostic: the field walk is the same for every key type, so a type we do
 * not model is checked as well as one we do.
 */
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

/**
 * The ONE way this file turns a base64 field into bytes. Every base64 field on a known_hosts line —
 * key blob, hash salt, host hash — must come through here, so a field added later cannot quietly
 * skip the rule.
 *
 * Why re-encode and compare: Buffer.from never throws on bad base64, it silently SKIPS invalid
 * characters, so `<valid>!!!` and a field with `@@` spliced into it both decode to the same correct
 * bytes. ssh rejects those lines outright ("parse error in hostkeys file", "salt decode error"), so
 * accepting them grants trust from a line the user's own ssh ignores; `<valid>AAAA` is worse still,
 * decoding to different bytes that still parse, which reads as a CHANGED key.
 *
 * The comparison is EXACT, padding included, which is what OpenSSH's b64_pton does: it rejects a
 * missing `=`, a stray one, the base64url alphabet, and a final character whose leftover bits are
 * non-zero. Verified live against OpenSSH 10.2p1 — each of those mutations on a real `ssh-keygen -H`
 * salt makes ssh refuse to find the host at all.
 */
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
  // Length is orthogonal to canonicality, so both checks are needed: ssh requires BOTH fields to be
  // exactly one SHA1 digest — extract_salt rejects anything else with "expected salt len 20, got N".
  // Accepting a shorter salt would let us match a line ssh treats as a parse error, so the entry
  // would be invisible to the user's own ssh but trusted by us.
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
      // Why drop rather than ignore the marker: an unrecognised marker may restrict the line in a
      // way we do not model, so honouring the line as if it were unmarked would over-trust it.
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
    // The hash covers the candidate form verbatim, so a bracketed candidate hashes as
    // "[host]:port" — each form must be hashed separately rather than hashing the bare host once.
    const digest = createHmac('sha1', entry.hashed.salt).update(candidate).digest()
    return digest.length === entry.hashed.hash.length && timingSafeEqual(digest, entry.hashed.hash)
  }
  // A single negation vetoes the entire line even when another pattern on it matches.
  if (entry.negations.some((pattern) => patternMatches(pattern, candidate))) {
    return false
  }
  return entry.patterns.some((pattern) => patternMatches(pattern, candidate))
}

/**
 * The candidate forms, in the order OpenSSH tries them.
 *
 * A non-default port looks up `[host]:port` first and, finding nothing, retries the bare host —
 * "checking without port identifier" in `ssh -v`. Collapsing these into one set would give a
 * spurious first-contact result to anyone holding a bare line who connects on a non-default port.
 *
 * `HostKeyAlias` suppresses the port ENTIRELY: ssh looks the alias up bare and never brackets it.
 * Verified against OpenSSH 10.2p1 on port 2225 with HostKeyAlias=myalias — an entry keyed `myalias`
 * authenticates, and one keyed `[myalias]:2225` gives "No ED25519 host key is known for myalias".
 * Bracketing an alias is not merely a stale-entry false alarm: because the first pass now decides
 * as soon as it finds any entry, a leftover `[alias]:port` line would BLOCK the bare lookup that
 * ssh actually performs, turning a working bastion into a hard failure.
 */
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

/**
 * Decide an outcome for one presented key against a set of entries.
 *
 * Entries from several files are unioned by the caller: any exact hit in any file wins, and a
 * disagreeing entry in another file does not make it a mismatch.
 */
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

  // A CA line is a MARKER, so it never satisfies a plain host key and never stops the fallback pass.
  // Tracked across passes because it describes the host either way.
  let sawCertAuthority = false

  for (let passIndex = 0; passIndex < passes.length; passIndex += 1) {
    const candidates = passes[passIndex]!
    // Per pass, never carried forward. These describe what THIS candidate form knows, and the
    // fallback form's knowledge is not admissible as evidence of a change — see below.
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
      // Byte equality implies the types agree: the blob carries its own algorithm name, and parsing
      // already rejected any line whose declared type disagreed with it.
      if (entry.key.equals(query.key)) {
        return 'match'
      }
      sawPlainEntryForHost = true
      sawSameTypeForHost ||= entry.keyType === query.keyType
    }

    // The first pass decides if it knows this host AT ALL. OpenSSH runs the bare-host fallback only
    // when the port-qualified lookup matched no plain entry of ANY type; when one was there, its
    // verdict is final. Verified live against OpenSSH 10.2p1 on 127.0.0.1:2223 — an off-port RSA
    // entry plus a bare, correct ed25519 line makes ssh print IDENTIFICATION HAS CHANGED with no
    // "checking without port identifier", where continuing to the fallback returns `match` and
    // ACCEPTS A CHANGED KEY.
    if (passIndex === 0 && sawPlainEntryForHost) {
      // Both refuse. The distinction only picks the message: a changed key of the type we hold, or
      // a type we have never seen for a host we do know. ssh calls both HOST_CHANGED.
      return sawSameTypeForHost ? 'mismatch' : 'unknown-type-known-host'
    }
  }

  // Nothing after the first pass may report a change. On the fallback pass OpenSSH downgrades any
  // non-match to "not known" — including an entry of another type, which it treats as plain first
  // contact. Verified live: a bare ssh-rsa entry, dialed on 2223 against an ed25519-only server,
  // makes ssh add the host and connect. Reporting unknown-type-known-host there refuses a host ssh
  // accepts, which is why these flags are scoped to their pass.
  return sawCertAuthority ? 'ca-only' : 'unknown'
}
