/**
 * Orca's own record of accepted SSH host keys, consulted alongside the user's `known_hosts`.
 *
 * We read `known_hosts` but never write it (D1), so accepted keys land here instead. See
 * docs/reference/ssh-host-key-verification.md — D1, D5 and D8 are the load-bearing decisions.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withSidecarSnapshotQueue, writeSidecarSnapshot } from '../sidecar-snapshot-file'
import {
  formatHostKeyFingerprint,
  readHostKeyType,
  type KnownHostsOutcome,
  type KnownHostsQuery
} from './ssh-known-hosts'

const STORE_FILE_NAME = 'ssh-host-keys.json'
const STORE_VERSION = 1
const MAX_PORT = 65535

export type TrustedHostKeyRecord = {
  /** Lower-cased `HostKeyAlias` or resolved hostname — never the Orca target label (D2 lookup key). */
  host: string
  port: number
  keyType: string
  /** The presented blob, base64. Matching compares these bytes; the fingerprint is for display. */
  key: string
  fingerprint: string
  acceptedAt: string
}

/**
 * Our store holds neither CA nor revoked entries, so it can only reach four of the six outcomes —
 * but they are the same four, so a caller can union this with `matchKnownHosts` untranslated.
 */
export type HostKeyStoreOutcome = Extract<
  KnownHostsOutcome,
  'match' | 'mismatch' | 'unknown-type-known-host' | 'unknown'
>

type HostKeyStoreFile = {
  version: number
  hostKeys: TrustedHostKeyRecord[]
}

/** Beside the profile's data file, like the GitHub cache and scrollback snapshots. */
export function getSshHostKeyStoreFile(dataFile: string): string {
  return join(dirname(dataFile), STORE_FILE_NAME)
}

let configuredStoreFile: string | null = null

/** Bind the store to the active profile once at startup, so connect paths need not thread `dataFile`. */
export function initSshHostKeyStoreFile(dataFile: string): void {
  configuredStoreFile = getSshHostKeyStoreFile(dataFile)
}

/** The bound store path, for messages that must name the artefact a user has to remove. */
export function boundSshHostKeyStoreFile(): string | null {
  return configuredStoreFile
}

/**
 * Why throw rather than default to empty: an unconfigured store is a wiring bug, and answering
 * "nothing trusted" would quietly turn every host into first contact. The verifier wraps its work
 * and denies on throw (D7), so failing loudly here still fails closed.
 */
function requireStoreFile(file?: string): string {
  const resolved = file ?? configuredStoreFile
  if (!resolved) {
    throw new Error('SSH host key store used before initSshHostKeyStoreFile()')
  }
  return resolved
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= MAX_PORT
}

function decodeStoredKey(record: TrustedHostKeyRecord): Buffer | undefined {
  // Buffer.from never throws on bad base64, it silently truncates — so re-derive and compare.
  const key = Buffer.from(record.key, 'base64')
  if (
    key.length === 0 ||
    key.toString('base64').replace(/=+$/, '') !== record.key.replace(/=+$/, '')
  ) {
    return undefined
  }
  // The blob's own algorithm header must agree with the record's type field, or a tampered or
  // corrupted record could claim a type it does not carry and satisfy a lookup for it.
  return readHostKeyType(key) === record.keyType ? key : undefined
}

function fingerprintOf(key: Buffer): string {
  return formatHostKeyFingerprint(createHash('sha256').update(key).digest('base64'))
}

function validateRecord(candidate: unknown): TrustedHostKeyRecord | undefined {
  if (!candidate || typeof candidate !== 'object') {
    return undefined
  }
  const { host, port, keyType, key, fingerprint, acceptedAt } = candidate as Record<string, unknown>
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    !isValidPort(port) ||
    typeof keyType !== 'string' ||
    keyType.length === 0 ||
    typeof key !== 'string' ||
    typeof fingerprint !== 'string' ||
    typeof acceptedAt !== 'string'
  ) {
    return undefined
  }
  const record: TrustedHostKeyRecord = {
    host: normalizeHost(host),
    port,
    keyType,
    key,
    fingerprint,
    acceptedAt
  }
  const decoded = decodeStoredKey(record)
  // A fingerprint that disagrees with its key means the record was corrupted or hand-edited; D5
  // shows this fingerprint to the user, so a record we cannot vouch for is dropped rather than shown.
  return decoded && fingerprintOf(decoded) === fingerprint ? record : undefined
}

/**
 * What one read of the store found. `withheld` is the distinction the read path does not care about
 * and the WRITE path cannot do without: the file exists and holds records we could not see, so a
 * rewrite would delete keys rather than supersede them. Same doctrine ssh-known-hosts-source.ts
 * applies to `known_hosts` — a file that exists and refuses to open is evidence withheld, not absent.
 */
type StoreSnapshot =
  | { status: 'ok'; records: TrustedHostKeyRecord[] }
  | { status: 'absent' }
  | { status: 'withheld'; reason: string }

async function readStore(storeFile: string): Promise<StoreSnapshot> {
  let contents: string
  try {
    contents = await readFile(storeFile, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent' }
    }
    console.warn(`[ssh] Could not read the host key store at ${storeFile}:`, error)
    return { status: 'withheld', reason: 'it could not be read' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    // Deliberately NOT withheld: unparseable records are unrecoverable by any version, so there is
    // nothing left for a rewrite to destroy and refusing to write would wedge the store permanently.
    console.warn(`[ssh] Host key store at ${storeFile} is not valid JSON; treating it as empty`)
    return { status: 'ok', records: [] }
  }

  // Why the version is consulted: it was written and never read, so a store from a future Orca would
  // have every record dropped by validateRecord and then be REWRITTEN as v1 — silently discarding
  // whatever that version knew. Refusing both to trust and to overwrite keeps the file intact for the
  // version that owns it.
  const onDiskVersion = (parsed as Partial<HostKeyStoreFile> | null)?.version
  if (typeof onDiskVersion === 'number' && onDiskVersion > STORE_VERSION) {
    console.warn(
      `[ssh] Host key store at ${storeFile} is version ${onDiskVersion}, newer than ${STORE_VERSION}; leaving it alone and trusting nothing from it`
    )
    return { status: 'withheld', reason: `it is version ${onDiskVersion}` }
  }

  const hostKeys = (parsed as Partial<HostKeyStoreFile> | null)?.hostKeys
  if (!Array.isArray(hostKeys)) {
    console.warn(`[ssh] Host key store at ${storeFile} has no host key list; treating it as empty`)
    return { status: 'ok', records: [] }
  }

  const records: TrustedHostKeyRecord[] = []
  let dropped = 0
  for (const candidate of hostKeys) {
    const record = validateRecord(candidate)
    if (record) {
      records.push(record)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    console.warn(
      `[ssh] Ignored ${dropped} unusable record(s) in the host key store at ${storeFile}`
    )
  }
  return { status: 'ok', records }
}

/**
 * Every trusted record, or an empty list when the file is missing or unreadable.
 *
 * Never throws and never fails open: a corrupt file degrades to "nothing trusted", which costs a
 * first-contact prompt, where the opposite mistake would accept anything. Callers that go on to
 * WRITE must not use this — see readStore, whose `withheld` case this one deliberately flattens.
 */
export async function loadTrustedHostKeys(file?: string): Promise<TrustedHostKeyRecord[]> {
  const snapshot = await readStore(requireStoreFile(file))
  return snapshot.status === 'ok' ? snapshot.records : []
}

/**
 * Whether these records hold this key for this endpoint.
 *
 * Scoped to host + port + key type (D8), and exactly — unlike `known_hosts` there is no bare-host
 * fallback pass, because we only ever record the endpoint we actually connected to.
 *
 * Pure and separate from the load so the connect path can reuse it against records it preloaded:
 * ssh2's verifier decides synchronously and cannot await the file. Duplicating the comparison there
 * instead is what produced the type downgrade this outcome set exists to prevent — one copy answered
 * only match/mismatch/unknown, so a record of another type read as first contact.
 */
export function matchTrustedHostKeys(
  records: readonly TrustedHostKeyRecord[],
  query: KnownHostsQuery
): HostKeyStoreOutcome {
  const host = normalizeHost(query.host)
  let sawSameType = false
  let sawOtherType = false

  for (const record of records) {
    if (record.host !== host || record.port !== query.port) {
      continue
    }
    if (record.keyType !== query.keyType) {
      sawOtherType = true
      continue
    }
    if (decodeStoredKey(record)?.equals(query.key)) {
      return 'match'
    }
    sawSameType = true
  }

  if (sawSameType) {
    return 'mismatch'
  }
  // We hold a key for this endpoint, just not of the presented type. Never a first-contact result:
  // an attacker who cannot forge the type on file would otherwise present another for a soft outcome.
  return sawOtherType ? 'unknown-type-known-host' : 'unknown'
}

/** The key types we already hold for one endpoint, for the algorithm ordering that makes D3 safe. */
export function storedKeyTypesForEndpoint(
  records: readonly TrustedHostKeyRecord[],
  host: string,
  port: number
): string[] {
  const normalized = normalizeHost(host)
  return records
    .filter((record) => record.host === normalized && record.port === port)
    .map((record) => record.keyType)
}

/** Whether we have previously accepted this key for this endpoint. */
export async function isTrusted(
  query: KnownHostsQuery,
  file?: string
): Promise<HostKeyStoreOutcome> {
  return matchTrustedHostKeys(await loadTrustedHostKeys(file), query)
}

/**
 * Record an accepted key, superseding any earlier key for the same host + port + type.
 *
 * Takes the presented blob rather than a pre-built record so the stored base64 and fingerprint
 * cannot disagree with each other.
 */
export async function trustHostKey(
  query: KnownHostsQuery,
  file?: string
): Promise<TrustedHostKeyRecord> {
  const storeFile = requireStoreFile(file)
  const record: TrustedHostKeyRecord = {
    host: normalizeHost(query.host),
    port: query.port,
    keyType: query.keyType,
    key: query.key.toString('base64'),
    fingerprint: fingerprintOf(query.key),
    acceptedAt: new Date().toISOString()
  }
  // Serialized: startup restore connects to every previously-active target in parallel, so two
  // first-contact accepts can otherwise read the same snapshot and one overwrites the other.
  await withSidecarSnapshotQueue(storeFile, async () => {
    // Inside the queue so the read and the write cannot be separated by another writer.
    const snapshot = await readStore(storeFile)
    if (snapshot.status === 'withheld') {
      // Not an error the caller should fail on: the key verified, we simply decline to write a file
      // whose current contents we cannot see. Writing would replace every other host's pinned key
      // with this one record, so the next connect to those hosts would re-TOFU — and one whose key
      // had genuinely changed would be accepted as first contact instead of refused. The next
      // connect re-derives this decision from known_hosts.
      console.warn(
        `[ssh] Not recording the host key for ${record.host}:${record.port}: the store at ${storeFile} was left alone because ${snapshot.reason}`
      )
      return
    }
    const kept = (snapshot.status === 'ok' ? snapshot.records : []).filter(
      (existing) =>
        existing.host !== record.host ||
        existing.port !== record.port ||
        existing.keyType !== record.keyType
    )
    await persist(storeFile, [...kept, record])
    // Inside the branch that actually wrote: the withheld path logged its own reason, and claiming
    // "Trusted" for a record that never reached disk makes the next connect's re-prompt unreadable.
    console.warn(
      `[ssh] Trusted host key for ${record.host}:${record.port} (${record.keyType} ${record.fingerprint})`
    )
  })
  return record
}

/** Temp file + fsync + rename, so a crash mid-write can never publish a half-written trust list. */
async function persist(storeFile: string, hostKeys: TrustedHostKeyRecord[]): Promise<void> {
  await mkdir(dirname(storeFile), { recursive: true }).catch(() => {})
  await writeSidecarSnapshot(storeFile, {
    version: STORE_VERSION,
    hostKeys
  } satisfies HostKeyStoreFile)
}
