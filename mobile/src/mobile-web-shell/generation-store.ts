import { z } from 'zod'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { joinUri } from './generation-cache-uri'
import type { GenerationDirectoryEntry, GenerationFileSystem } from './generation-store-file-system'
import {
  MANIFEST_FILE_NAME,
  NEXT_MANIFEST_FILE_NAME,
  parseGenerationManifest,
  settleManifestSwap,
  swapInFreshManifest
} from './generation-manifest-swap'
import { refuseManifestPersist, type ManifestPersistOutcome } from './manifest-persist-refusal'
import { isHostCacheKey } from './host-cache-key'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'
import {
  forgetHostUpdateFailuresIn,
  readUpdateFailureLog,
  recordUpdateFailureIn
} from './mobile-web-shell-update-failure-log'

const GENERATIONS_DIRECTORY_NAME = 'generations'
const STAGING_DIRECTORY_NAME = 'tmp'
const HOST_INDEX_FILE_NAME = 'hosts.json'

/** The architecture reference's cache ceiling: four hosts, least recently activated evicted. */
export const MAX_CACHED_HOSTS = 4

export type ActiveGeneration = {
  readonly buildId: string
  /** Read-only input for the native view; nothing but this store writes under it. */
  readonly directory: string
  readonly manifest: MobileWebBundleManifestRead
}

export type StagedGeneration = {
  readonly hostKey: string
  readonly buildId: string
  readonly directory: string
  readonly manifest: MobileWebBundleManifestRead
}

export type GenerationStore = {
  readActiveGeneration(hostKey: string): Promise<ActiveGeneration | null>
  stageGeneration(hostKey: string, result: MobileWebBundleFetchResult): Promise<StagedGeneration>
  commitGeneration(staged: StagedGeneration): Promise<ActiveGeneration>
  abortStagedGeneration(staged: StagedGeneration): Promise<void>
  sweepStagedGenerations(): Promise<void>
  deleteHostCache(hostKey: string): Promise<void>
  /**
   * Rewrites the manifest stored beside a host's active generation, and nothing else.
   *
   * For the one edit that changes a manifest without changing a byte of the bundle: route grants
   * are published under the build id of the assets they describe, so a same-build cache hit holds
   * the right bytes under a manifest an edit behind. The stored manifest is what an unreachable
   * host is judged by, so until it is rewritten every offline verdict lags.
   */
  persistActiveManifest(
    hostKey: string,
    manifest: MobileWebBundleManifestRead
  ): Promise<ManifestPersistOutcome>
  /** Why an update read failed, kept for Troubleshoot. Never rejects: it is only evidence. */
  recordUpdateFailure(failure: MobileWebShellUpdateFailure): Promise<void>
  /** Oldest first; empty when nothing was recorded or the log cannot be read. */
  readUpdateFailures(): Promise<readonly MobileWebShellUpdateFailure[]>
  /** Keyed by host id, not cache key: the log outlives the host's generations. Never rejects. */
  forgetHostUpdateFailures(hostId: string): Promise<void>
}

/** Recency only, so anything unreadable degrades to "evict this host first". */
const HostIndexSchema = z.record(z.string(), z.number().int().nonnegative())

export function createGenerationStore(options: {
  fileSystem: GenerationFileSystem
  now?: () => number
}): GenerationStore {
  const fs = options.fileSystem
  const now = options.now ?? Date.now
  // `StagedGeneration` is structurally typed, so any object of that shape would otherwise let
  // `commitGeneration` rename over, and `abortStagedGeneration` delete, a directory of the caller's
  // choosing. Only handles this store minted are honoured.
  const issuedHandles = new WeakSet<StagedGeneration>()

  const hostRoot = (hostKey: string): string => joinUri(fs.rootUri, requireHostKey(hostKey))
  const generationsRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), GENERATIONS_DIRECTORY_NAME)
  const stagingRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), STAGING_DIRECTORY_NAME)

  async function readHostIndex(): Promise<Map<string, number>> {
    // Unreadable is treated as absent here, unlike a manifest: an index nobody can read costs
    // eviction order, and the next activation rewrites it whole.
    const text = await fs.readText(joinUri(fs.rootUri, HOST_INDEX_FILE_NAME)).catch(() => null)
    const parsed = text === null ? null : HostIndexSchema.safeParse(parseJson(text))
    return new Map(Object.entries(parsed?.success === true ? parsed.data : {}))
  }

  async function writeHostIndex(index: ReadonlyMap<string, number>): Promise<void> {
    // Recency, not truth: a full disk here must not turn an activation that is already on disk
    // into a thrown commit, and the next activation rewrites the whole index anyway.
    await fs
      .writeText(
        joinUri(fs.rootUri, HOST_INDEX_FILE_NAME),
        JSON.stringify(Object.fromEntries(index))
      )
      .catch(() => undefined)
  }

  async function listHostDirectories(): Promise<readonly GenerationDirectoryEntry[]> {
    const entries = await fs.list(fs.rootUri)
    return entries.filter((entry) => entry.isDirectory && isHostCacheKey(entry.name))
  }

  /** The ceiling counts cached generations, so a host that only holds a download in progress is
   *  neither counted nor evictable: evicting it would delete the tree its own commit is about to
   *  rename. Sweeping still walks every host directory, staged-only ones included. */
  async function listActivatedHosts(): Promise<readonly string[]> {
    const activated: string[] = []
    for (const host of await listHostDirectories()) {
      const generations = await fs.list(joinUri(fs.rootUri, host.name, GENERATIONS_DIRECTORY_NAME))
      if (generations.some((entry) => entry.isDirectory)) {
        activated.push(host.name)
      }
    }
    return activated
  }

  async function dropHostTree(hostKey: string): Promise<void> {
    await fs.delete(hostRoot(hostKey))
  }

  async function enforceHostLimit(index: Map<string, number>, activated: string): Promise<void> {
    const hosts = await listActivatedHosts()
    const present = new Set(hosts)
    for (const key of Array.from(index.keys())) {
      if (!present.has(key)) {
        index.delete(key)
      }
    }
    // A host with no index entry sorts first: the index is recency, not truth, so a lost or
    // truncated one costs eviction order rather than a generation. The host just activated is
    // never a candidate, because `now()` is a wall clock: one backward jump would otherwise make
    // the newest entry the oldest and evict the tree the caller is about to open.
    const candidates = hosts
      .filter((host) => host !== activated)
      .sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0))
    for (const host of candidates.slice(0, Math.max(0, hosts.length - MAX_CACHED_HOSTS))) {
      await dropHostTree(host)
      index.delete(host)
    }
    await writeHostIndex(index)
  }

  async function readActive(hostKey: string): Promise<ActiveGeneration | null> {
    const generations = generationsRoot(hostKey)
    const directories = (await fs.list(generations)).filter((entry) => entry.isDirectory)
    if (directories.length === 0) {
      return null
    }
    // Two directories means a commit was interrupted between dropping the old generation and
    // renaming the new one. There is no activation file to break the tie, and a manifest that
    // names another build is a tree from some other bundle, so the host's cache goes and the next
    // open redownloads it.
    const only = directories.length === 1 ? directories[0] : null
    if (only !== null) {
      const directory = joinUri(generations, only.name)
      // A persist interrupted anywhere leaves a pending manifest; finishing or discarding it here
      // is what makes the swap crash-safe. Unsettleable is not a bad generation — the pending file
      // may be the only manifest left — so nothing is deleted and the next read tries again.
      if ((await settleManifestSwap(fs, directory, only.name)) === 'unsettled') {
        return null
      }
      let text: string | null
      try {
        text = await fs.readText(joinUri(directory, MANIFEST_FILE_NAME))
      } catch {
        // A failed read is not evidence of a bad generation, so nothing is deleted: the caller
        // redownloads, and a transient I/O blip must not cost a cache that verified.
        return null
      }
      const manifest = parseGenerationManifest(text)
      if (manifest !== null && manifest.buildId === only.name) {
        return { buildId: manifest.buildId, directory, manifest }
      }
    }
    await dropHostTree(hostKey)
    return null
  }

  async function stage(
    hostKey: string,
    result: MobileWebBundleFetchResult
  ): Promise<StagedGeneration> {
    const manifest = result.manifest
    const directory = joinUri(stagingRoot(hostKey), manifest.buildId)
    const assets = manifest.assets.map((asset) => ({
      uri: joinUri(directory, requireStorablePath(asset.path)),
      bytes: requireExactBytes(result.assets.get(asset.path), asset)
    }))
    // Residue from an earlier attempt is dropped rather than written over: a half-written tree
    // plus a fresh write is not a generation either side verified.
    await fs.delete(directory)
    try {
      for (const asset of assets) {
        await fs.writeBytes(asset.uri, asset.bytes)
      }
      // Last, always: a tree without it never reads back as an activation, which is what makes an
      // interrupted write recoverable rather than ambiguous.
      await fs.writeText(joinUri(directory, MANIFEST_FILE_NAME), JSON.stringify(manifest))
    } catch (error) {
      await fs.delete(directory).catch(() => undefined)
      throw error
    }
    const handle: StagedGeneration = { hostKey, buildId: manifest.buildId, directory, manifest }
    issuedHandles.add(handle)
    return handle
  }

  function requireIssuedHandle(staged: StagedGeneration): StagedGeneration {
    if (!issuedHandles.has(staged)) {
      throw new Error('generation store was handed a staged handle it did not issue')
    }
    return staged
  }

  async function commit(staged: StagedGeneration): Promise<ActiveGeneration> {
    requireIssuedHandle(staged)
    const generations = generationsRoot(staged.hostKey)
    const target = joinUri(generations, staged.buildId)
    const active: ActiveGeneration = {
      buildId: staged.buildId,
      directory: target,
      manifest: staged.manifest
    }
    const entries = await fs.list(generations)
    // The build id names an asset list, not evidence those bytes landed, so a directory of that name
    // is this activation only once its manifest is on disk. An empty one — what a crash between the
    // rename and the check below leaves on Android under API 26 — or a plain file of that name falls
    // through and is replaced by the staged tree, which was verified byte for byte.
    const existing = entries.find((entry) => entry.name === staged.buildId)
    if (
      existing?.isDirectory === true &&
      (await fs.fileExists(joinUri(target, MANIFEST_FILE_NAME)))
    ) {
      // Still an activation, so it still counts as use: without this a host that redownloads the
      // bundle it already has stays the least recently activated and is evicted first. No eviction
      // pass, because the host count did not change.
      const index = await readHostIndex()
      index.set(staged.hostKey, now())
      await writeHostIndex(index)
      await fs.delete(staged.directory)
      return active
    }
    // Before any delete: an aborted or swept handle must not cost the live generation, and a tree
    // that is no longer on disk cannot be renamed into one either.
    if (!(await fs.fileExists(joinUri(staged.directory, MANIFEST_FILE_NAME)))) {
      throw new Error(`staged generation ${staged.buildId} is no longer on disk`)
    }
    // Every other generation goes before the rename, never after. A crash between the two leaves
    // zero generations, which the runbook's redownload rule already covers; the other order can
    // leave two directories under `generations/` with nothing to say which one is the activation.
    for (const entry of entries) {
      await fs.delete(joinUri(generations, entry.name))
    }
    await fs.createDirectory(generations)
    await fs.moveDirectory(staged.directory, target)
    // Android below API 26 implements a directory move as a non-recursive copy plus a delete
    // (expo-file-system android FileSystemPath.kt:158-173), which can land an empty directory. Its
    // `delete()` then fails on the non-empty source, so the tmp tree survives for the next sweep.
    if (!(await fs.fileExists(joinUri(target, MANIFEST_FILE_NAME)))) {
      await fs.delete(target)
      throw new Error(`generation ${staged.buildId} did not carry its manifest through the rename`)
    }
    const index = await readHostIndex()
    index.set(staged.hostKey, now())
    // Enforced here rather than left to a caller: the four-host ceiling is this module's invariant.
    await enforceHostLimit(index, staged.hostKey)
    return active
  }

  async function persistManifest(
    hostKey: string,
    manifest: MobileWebBundleManifestRead
  ): Promise<ManifestPersistOutcome> {
    const active = await readActive(hostKey)
    if (active === null) {
      return 'refused-no-active-generation'
    }
    const refusal = refuseManifestPersist(active.manifest, manifest)
    if (refusal !== null) {
      return refusal
    }
    await swapInFreshManifest(fs, active.directory, manifest)
    return 'persisted'
  }

  async function sweep(): Promise<void> {
    // Every host's `tmp`, not just the one being opened: an interrupted download must not survive a
    // restart, and it may belong to a host this launch never selects.
    for (const host of await listHostDirectories()) {
      await fs.delete(joinUri(fs.rootUri, host.name, STAGING_DIRECTORY_NAME))
    }
  }

  async function deleteHost(hostKey: string): Promise<void> {
    await dropHostTree(hostKey)
    const index = await readHostIndex()
    if (index.delete(hostKey)) {
      await writeHostIndex(index)
    }
  }

  // One queue for the whole store rather than one per host: every operation is a short burst of
  // cache I/O, and a single order answers the stage/commit/sweep/delete interleavings at once. A
  // second `stageGeneration` for the same host and build waits for the first rather than writing
  // into the tree it is still filling.
  let tail: Promise<unknown> = Promise.resolve()
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(operation, operation)
    tail = run.catch(() => undefined)
    return run
  }

  return {
    readActiveGeneration: (hostKey) => serialize(() => readActive(hostKey)),
    stageGeneration: (hostKey, result) => serialize(() => stage(hostKey, result)),
    commitGeneration: (staged) => serialize(() => commit(staged)),
    abortStagedGeneration: (staged) =>
      serialize(() => fs.delete(requireIssuedHandle(staged).directory)),
    sweepStagedGenerations: () => serialize(sweep),
    deleteHostCache: (hostKey) => serialize(() => deleteHost(hostKey)),
    persistActiveManifest: (hostKey, manifest) =>
      serialize(() => persistManifest(hostKey, manifest)),
    recordUpdateFailure: (failure) =>
      serialize(() => recordUpdateFailureIn(fs, failure)).catch(() => undefined),
    readUpdateFailures: () => serialize(() => readUpdateFailureLog(fs)),
    forgetHostUpdateFailures: (hostId) =>
      serialize(() => forgetHostUpdateFailuresIn(fs, hostId)).catch(() => undefined)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function requireHostKey(hostKey: string): string {
  if (!isHostCacheKey(hostKey)) {
    throw new Error('generation store was handed something that is not a host cache key')
  }
  return hostKey
}

/** The manifest schema bans traversal already, but this is the last code between a manifest and a
 *  write, and both manifest names are the store's own rather than an asset's to take: the pending
 *  one would be read back as an activation. Folded, because APFS and NTFS are case-insensitive and
 *  `Manifest.JSON` would land on the same file. */
function requireStorablePath(path: string): string {
  const segments = path.split('/')
  const folded = path.toLowerCase()
  const storable =
    path.length > 0 &&
    folded !== MANIFEST_FILE_NAME &&
    folded !== NEXT_MANIFEST_FILE_NAME &&
    !path.includes('\\') &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  if (!storable) {
    throw new Error(`generation store refuses to stage the asset path ${path}`)
  }
  return path
}

function requireExactBytes(
  bytes: Uint8Array | undefined,
  asset: { path: string; byteLength: number }
): Uint8Array {
  // Only complete generations activate, so the check is before the first write rather than after
  // the last: a manifest asset that is absent or the wrong length never reaches disk.
  if (bytes === undefined || bytes.byteLength !== asset.byteLength) {
    throw new Error(
      `bundle asset ${asset.path} is ${bytes?.byteLength ?? 'absent'}, not the manifest's ${asset.byteLength}`
    )
  }
  return bytes
}
