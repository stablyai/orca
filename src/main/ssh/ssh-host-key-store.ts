/** Record accepted keys beside the profile; consult user known_hosts without writing it. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withSidecarSnapshotQueue, writeSidecarSnapshot } from '../sidecar-snapshot-file'
import {
  formatHostKeyFingerprint,
  readHostKeyType,
  type KnownHostsOutcome,
  type KnownHostsQuery
} from './config/ssh-known-hosts'

const STORE_FILE_NAME = 'ssh-host-keys.json'
const STORE_VERSION = 1
const MAX_PORT = 65535

type TrustedHostKeyRecord = {
  /** Lower-cased lookup host/HostKeyAlias, never the Orca target label. */
  host: string
  port: number
  keyType: string
  /** Match blob bytes; fingerprint is display-only. */
  key: string
  fingerprint: string
  acceptedAt: string
}

/** Reuse known_hosts outcomes; this store has no CA/revoked entries. */
type HostKeyStoreOutcome = Extract<
  KnownHostsOutcome,
  'match' | 'mismatch' | 'unknown-type-known-host' | 'unknown'
>

type HostKeyStoreFile = {
  version: number
  hostKeys: TrustedHostKeyRecord[]
}

export function getSshHostKeyStoreFile(dataFile: string): string {
  return join(dirname(dataFile), STORE_FILE_NAME)
}

let configuredStoreFile: string | null = null

export function initSshHostKeyStoreFile(dataFile: string): void {
  configuredStoreFile = getSshHostKeyStoreFile(dataFile)
}

export function boundSshHostKeyStoreFile(): string | null {
  return configuredStoreFile
}

/** Unconfigured storage is a wiring error, never an empty trust list; throw so verifier handles failure explicitly. */
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
  // Buffer.from silently truncates malformed base64; require canonical roundtrip.
  const key = Buffer.from(record.key, 'base64')
  if (
    key.length === 0 ||
    key.toString('base64').replace(/=+$/, '') !== record.key.replace(/=+$/, '')
  ) {
    return undefined
  }
  // Require blob algorithm to match declared type so corrupted records cannot satisfy another type's lookup.
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
  // Drop records whose display fingerprint disagrees with their bytes.
  return decoded && fingerprintOf(decoded) === fingerprint ? record : undefined
}

/** Withheld means existing records are unreadable/too new: reads trust none, but writes must preserve them. */
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
    // Invalid JSON is unrecoverable; allow replacement rather than permanently wedging the store.
    console.warn(`[ssh] Host key store at ${storeFile} is not valid JSON; treating it as empty`)
    return { status: 'ok', records: [] }
  }

  // Preserve newer formats without trusting them; validating as v1 then rewriting would destroy future records.
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

/** Missing/unreadable storage returns no trusted records. Writers must use readStore so withheld evidence never becomes an empty replacement. */
export async function loadTrustedHostKeys(file?: string): Promise<TrustedHostKeyRecord[]> {
  const snapshot = await readStore(requireStoreFile(file))
  return snapshot.status === 'ok' ? snapshot.records : []
}

/** Match exact host/port/type without bare-host fallback. Reuse this pure matcher for synchronous preloaded verification so type-switch detection cannot drift. */
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
  // A known endpoint offering another key type is never first contact.
  return sawOtherType ? 'unknown-type-known-host' : 'unknown'
}

/** Known endpoint types guide proposal ordering to prevent type-switch downgrade. */
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

export async function isTrusted(
  query: KnownHostsQuery,
  file?: string
): Promise<HostKeyStoreOutcome> {
  return matchTrustedHostKeys(await loadTrustedHostKeys(file), query)
}

/** Derive base64/fingerprint from the accepted blob and replace only its exact host/port/type record. */
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
  // Serialize concurrent first-contact accepts so one snapshot cannot overwrite another host's key.
  await withSidecarSnapshotQueue(storeFile, async () => {
    // Read inside the write queue to keep the full update atomic.
    const snapshot = await readStore(storeFile)
    if (snapshot.status === 'withheld') {
      // Verified connection may proceed, but unseen records must never be overwritten or other hosts would silently re-TOFU.
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
    // Log durable trust only after write; withheld paths must not claim persistence.
    console.warn(
      `[ssh] Trusted host key for ${record.host}:${record.port} (${record.keyType} ${record.fingerprint})`
    )
  })
  return record
}

/** Publish atomically with fsync/rename so crashes cannot expose a partial trust list. */
async function persist(storeFile: string, hostKeys: TrustedHostKeyRecord[]): Promise<void> {
  await mkdir(dirname(storeFile), { recursive: true }).catch(() => {})
  await writeSidecarSnapshot(storeFile, {
    version: STORE_VERSION,
    hostKeys
  } satisfies HostKeyStoreFile)
}
