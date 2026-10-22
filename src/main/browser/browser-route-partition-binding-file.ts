import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { isBrowserRoutePartition } from './browser-route-identity'

export const BINDING_STORE_VERSION = 2
const LEGACY_BINDING_STORE_VERSION = 1
const FINGERPRINT_RE = /^[a-f0-9]{64}$/

/**
 * Persisted binding for one route partition.
 *
 * `storageScope` names the environment record that owns the partition so
 * explicit lifecycle events (environment removal) and orphan collection can
 * find it without re-deriving an identity that needs a live connection.
 * `null` marks a pre-scope entry from the per-boot partition scheme, whose
 * partition name can no longer be derived and is therefore always an orphan.
 * `lastUsedAt` orders capacity eviction; 0 marks an entry written before the
 * store recorded it, which is therefore evicted first.
 * `aliasFingerprints` are newer identities adopted onto the partition. They sit beside
 * `fingerprint` rather than replacing it, so an older build that reads only `fingerprint`
 * still finds the same jar instead of reporting a binding conflict.
 */
export type BrowserRoutePartitionBinding = {
  fingerprint: string
  storageScope: string | null
  lastUsedAt: number
  aliasFingerprints?: readonly string[]
}

export const MAX_ALIAS_FINGERPRINTS = 2

export function bindingAnswersTo(
  binding: BrowserRoutePartitionBinding,
  fingerprint: string
): boolean {
  return binding.fingerprint === fingerprint || !!binding.aliasFingerprints?.includes(fingerprint)
}

export function assertBinding(partition: string, fingerprint: string): void {
  if (!isBrowserRoutePartition(partition) || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error('browser_route_partition_binding_invalid')
  }
}

export function assertStorageScope(storageScope: string): void {
  if (!FINGERPRINT_RE.test(storageScope)) {
    throw new Error('browser_route_partition_binding_invalid')
  }
}

export function readBoundedUtf8File(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error('binding file size invalid')
    }
    const contents = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = readSync(fd, contents, offset, size - offset, null)
      if (bytesRead === 0) {
        throw new Error('binding file truncated')
      }
      offset += bytesRead
    }
    const overflowProbe = Buffer.alloc(1)
    if (readSync(fd, overflowProbe, 0, 1, null) !== 0) {
      throw new Error('binding file grew during read')
    }
    return contents.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function parseBindings(
  value: unknown,
  maxBindings: number
): Record<string, BrowserRoutePartitionBinding> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const candidate = value as { version?: unknown; bindings?: unknown }
  const version = candidate.version
  if (
    (version !== BINDING_STORE_VERSION && version !== LEGACY_BINDING_STORE_VERSION) ||
    !candidate.bindings ||
    typeof candidate.bindings !== 'object' ||
    Array.isArray(candidate.bindings)
  ) {
    return null
  }
  const entries = Object.entries(candidate.bindings as Record<string, unknown>)
  if (entries.length > maxBindings) {
    return null
  }
  const bindings: Record<string, BrowserRoutePartitionBinding> = {}
  for (const [partition, entry] of entries) {
    const binding = parseBinding(version === LEGACY_BINDING_STORE_VERSION, entry)
    if (!binding) {
      return null
    }
    try {
      assertBinding(partition, binding.fingerprint)
    } catch {
      return null
    }
    bindings[partition] = binding
  }
  return bindings
}

function parseBinding(legacy: boolean, entry: unknown): BrowserRoutePartitionBinding | null {
  if (legacy) {
    return typeof entry === 'string'
      ? { fingerprint: entry, storageScope: null, lastUsedAt: 0 }
      : null
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }
  const candidate = entry as { fingerprint?: unknown; storageScope?: unknown; lastUsedAt?: unknown }
  if (typeof candidate.fingerprint !== 'string') {
    return null
  }
  const lastUsedAt = parseLastUsedAt(candidate.lastUsedAt)
  const aliases = parseAliasFingerprints(
    'aliasFingerprints' in entry ? entry.aliasFingerprints : undefined
  )
  const optional = aliases.length > 0 ? { aliasFingerprints: aliases } : {}
  if (candidate.storageScope === null) {
    return { fingerprint: candidate.fingerprint, storageScope: null, lastUsedAt, ...optional }
  }
  if (typeof candidate.storageScope !== 'string' || !FINGERPRINT_RE.test(candidate.storageScope)) {
    return null
  }
  return {
    fingerprint: candidate.fingerprint,
    storageScope: candidate.storageScope,
    lastUsedAt,
    ...optional
  }
}

// Why lenient: an alias only widens lookup, so a malformed one is dropped rather than
// making the whole binding file unreadable.
function parseAliasFingerprints(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((alias): alias is string => typeof alias === 'string' && FINGERPRINT_RE.test(alias))
    .slice(-MAX_ALIAS_FINGERPRINTS)
}

// Why: absent on entries written before eviction existed, which must evict first.
function parseLastUsedAt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
