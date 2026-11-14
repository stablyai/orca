import { joinUri } from '../mobile-web-shell/generations/generation-cache-uri'
import type {
  GenerationDirectoryEntry,
  GenerationFileListing,
  GenerationFileSystem
} from '../mobile-web-shell/generations/generation-store-file-system'
import { deriveHostCacheKey } from '../mobile-web-shell/generations/host-cache-key'
import { DEVICE_STORE_BUCKETS, DRAFT_TMP_SUFFIX, promoteLoneDraftTmp } from './device-store-files'
import type { DeviceStoreTable } from './device-store-seal'

const MIB = 1024 * 1024
// One cap per root, not per domain, so OTA domain names never freeze into the store binary.
export const DEVICE_STORE_CAPS: Readonly<Record<DeviceStoreTable, number>> = {
  cache: 128 * MIB,
  draft: 16 * MIB
}
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000
// Small rows still take a disk block.
const MIN_CHARGED_BYTES = 4096
const EVICT_DOWN_TO = 0.9

function chargedBytes(size: number): number {
  return Math.max(size, MIN_CHARGED_BYTES)
}

type IndexEntry = { bytes: number; usedAt: number }

// Per-root byte total kept in memory. Caps apply once the launch seed has walked the root; until then writes
// are bounded by the value cap. Without `exact`, files not touched this session are counted in `total` as a
// per-bucket upper bound and have no entry, so LRU order needs an exact pass first. Without `complete`, the
// last pass missed files it could not list or count, and `total` lacks them until a pass runs again.
export type RootIndex = {
  seeded: boolean
  exact: boolean
  complete: boolean
  total: number
  readonly entries: Map<string, IndexEntry>
}

export function createRootIndex(): RootIndex {
  return { seeded: false, exact: false, complete: false, total: 0, entries: new Map() }
}

export function recordIndexedFile(
  index: RootIndex,
  uri: string,
  size: number,
  usedAt: number
): void {
  forgetIndexedFile(index, uri)
  const bytes = chargedBytes(size)
  index.entries.set(uri, { bytes, usedAt })
  index.total += bytes
}

export function forgetIndexedFile(index: RootIndex, uri: string): void {
  const entry = index.entries.get(uri)
  if (entry) {
    index.entries.delete(uri)
    index.total -= entry.bytes
  }
}

export function forgetIndexedDirectory(index: RootIndex, directoryUri: string): void {
  const prefix = `${directoryUri}/`
  for (const uri of Array.from(index.entries.keys())) {
    if (uri.startsWith(prefix)) {
      forgetIndexedFile(index, uri)
    }
  }
}

// After the whole root was deleted: nothing is on disk, so the empty index is exact.
export function resetRootIndex(index: RootIndex): void {
  index.entries.clear()
  index.total = 0
  index.exact = true
  index.complete = true
}

// Drops the per-bucket estimates before an exact pass re-adds every file it finds.
export function keepOnlyIndexedFiles(index: RootIndex): void {
  index.total = 0
  for (const entry of index.entries.values()) {
    index.total += entry.bytes
  }
}

// Drafts are never evicted, so a write that would cross their cap is refused and the owner keeps the text in memory.
// A pass that missed files undercounts, so it may let a write past the cap but never refuses one wrongly.
export function wouldExceedCap(
  index: RootIndex,
  cap: number,
  changes: readonly { uri: string; size: number | null }[]
): boolean {
  if (!index.exact) {
    return false
  }
  let projected = index.total
  // Changes apply in order, so a key changed twice replaces its own earlier change, not the file on disk.
  const changed = new Map<string, number>()
  for (const { uri, size } of changes) {
    const bytes = size === null ? 0 : chargedBytes(size)
    projected += bytes - (changed.get(uri) ?? index.entries.get(uri)?.bytes ?? 0)
    changed.set(uri, bytes)
  }
  return projected > cap
}

// Reads stamp usedAt in memory; across launches the file mtime stands in for it.
export async function evictLeastRecentlyUsed(
  fs: GenerationFileSystem,
  index: RootIndex,
  cap: number
): Promise<void> {
  if (!index.exact || index.total <= cap) {
    return
  }
  const byAge = Array.from(index.entries.entries()).sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [uri] of byAge) {
    if (index.total <= cap * EVICT_DOWN_TO) {
      return
    }
    await fs.delete(uri)
    forgetIndexedFile(index, uri)
  }
}

export type RootSeed = {
  readonly fs: GenerationFileSystem
  readonly table: DeviceStoreTable
  readonly rootUri: string
  readonly index: RootIndex
  readonly now: number
  // Exact lists every file (drafts, and the cache once it crosses its cap); otherwise each bucket adds one
  // native size summary, several times cheaper than a JSI object per file.
  readonly exact: boolean
  // Null skips the orphan sweep: an unreadable host list must never wipe a paired host's data.
  loadPairedHostIds(): Promise<readonly string[] | null>
  // Each slice runs as its own store task so writes interleave and keep the totals current. Resolves false
  // when the slice threw: the pass goes on, so one unreadable host never leaves a root unseeded and uncapped.
  readonly runSlice: (slice: () => Promise<void>) => Promise<boolean>
}

function yieldToIdleCallback(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

// One pass per root: drop hosts that are no longer paired, expire old drafts, recover drafts a crash left only
// in .tmp, and build the index. Listings are synchronous JSI, so each runs in its own idle slice: the root,
// then one bucket of files at a time. An exact pass skips files already indexed, so it can run again to count
// what an earlier pass missed.
export async function seedRootIndex(seed: RootSeed): Promise<void> {
  const { fs, rootUri } = seed
  let complete = true
  const runSlice = async (slice: () => Promise<void>): Promise<void> => {
    await yieldToIdleCallback()
    if (!(await seed.runSlice(slice))) {
      complete = false
    }
  }
  let hostDirectories: readonly GenerationDirectoryEntry[] = []
  await runSlice(async () => {
    hostDirectories = await fs.list(rootUri)
  })
  // Read after the listing, so a host paired since then is either listed here or has no directory yet.
  const pairedHostIds = await seed.loadPairedHostIds().catch(() => null)
  const pairedHostKeys = pairedHostIds ? new Set(pairedHostIds.map(deriveHostCacheKey)) : null
  for (const hostDirectory of hostDirectories) {
    if (hostDirectory.isDirectory) {
      await seedHostDirectory(seed, runSlice, joinUri(rootUri, hostDirectory.name), pairedHostKeys)
    }
  }
  seed.index.seeded = true
  seed.index.exact = seed.exact
  seed.index.complete = complete
}

async function seedHostDirectory(
  seed: RootSeed,
  runSlice: (slice: () => Promise<void>) => Promise<void>,
  hostUri: string,
  pairedHostKeys: ReadonlySet<string> | null
): Promise<void> {
  const { fs, index } = seed
  if (pairedHostKeys && !pairedHostKeys.has(hostUri.slice(hostUri.lastIndexOf('/') + 1))) {
    await runSlice(async () => {
      await fs.delete(hostUri)
      forgetIndexedDirectory(index, hostUri)
    })
    return
  }
  for (const bucket of DEVICE_STORE_BUCKETS) {
    const bucketUri = joinUri(hostUri, bucket)
    await runSlice(() =>
      seed.exact ? seedBucket(seed, bucketUri) : estimateBucket(seed, bucketUri)
    )
  }
}

// An upper bound: each file is charged at most its size plus one block, and files this session already
// indexed are counted again until an exact pass.
async function estimateBucket(seed: RootSeed, bucketUri: string): Promise<void> {
  const { size, entryCount } = await seed.fs.summarizeDirectory(bucketUri)
  seed.index.total += size + entryCount * MIN_CHARGED_BYTES
}

async function seedBucket(seed: RootSeed, bucketUri: string): Promise<void> {
  const files = await seed.fs.listFiles(bucketUri)
  const names = new Set(files.map((file) => file.name))
  let missed = 0
  for (const file of files) {
    // A file can go between steps of a recovery; count the rest, and fail the slice so a later pass retries it.
    await seedFile(seed, bucketUri, file, names).catch(() => {
      missed += 1
    })
  }
  if (missed > 0) {
    throw new Error(`[device-store] ${String(missed)} files in a bucket were not counted`)
  }
}

async function seedFile(
  seed: RootSeed,
  bucketUri: string,
  file: GenerationFileListing,
  names: ReadonlySet<string>
): Promise<void> {
  const { fs, index } = seed
  const uri = joinUri(bucketUri, file.name)
  if (file.name.endsWith(DRAFT_TMP_SUFFIX)) {
    const targetName = file.name.slice(0, -DRAFT_TMP_SUFFIX.length)
    const promoted =
      seed.table === 'draft' && !names.has(targetName) ? await promoteLoneDraftTmp(fs, uri) : null
    if (promoted) {
      // A rename keeps the size and mtime.
      await seedFile(seed, bucketUri, { ...file, name: targetName }, names)
    }
    return
  }
  if (index.entries.has(uri)) {
    return
  }
  // A .tmp beside the target is a newer edit; only the reader, which can check its tag, settles that pair.
  if (
    seed.table === 'draft' &&
    !names.has(file.name + DRAFT_TMP_SUFFIX) &&
    file.modificationTime !== null &&
    seed.now - file.modificationTime > DRAFT_TTL_MS
  ) {
    await fs.delete(uri)
    return
  }
  recordIndexedFile(index, uri, file.size, file.modificationTime ?? 0)
}
