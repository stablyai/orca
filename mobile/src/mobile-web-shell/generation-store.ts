import { z } from 'zod'
import { createGenerationOwners, type GenerationOwner } from './generation-owners'
import {
  invalidateActiveBuild,
  INVALID_ACTIVE_BUILD,
  readActiveBuild,
  writeActiveBuild
} from './generation-active-index'
import {
  MobileWebBundleManifestReadSchema,
  type MobileWebBundleManifestRead
} from '../transport/mobile-web-bundle-reply-schemas'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { joinUri } from './generation-cache-uri'
import type { GenerationDirectoryEntry, GenerationFileSystem } from './generation-store-file-system'
import { isHostCacheKey } from './host-cache-key'
import { requireExactBytes, requireHostKey, requireStorablePath } from './generation-asset-path'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'
import {
  forgetHostUpdateFailuresIn,
  readUpdateFailureLog,
  recordUpdateFailureIn
} from './mobile-web-shell-update-failure-log'

const GENERATIONS_DIRECTORY_NAME = 'generations'
const STAGING_DIRECTORY_NAME = 'tmp'
const HOST_INDEX_FILE_NAME = 'hosts.json'
/** The activation's manifest: a generation directory is an activation only once this is in it. */
const MANIFEST_FILE_NAME = 'manifest.json'

/** Least recently used host evicted past this. */
export const MAX_CACHED_HOSTS = 6

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
  createOwner(): GenerationOwner
  readActiveGeneration(hostKey: string, owner?: GenerationOwner): Promise<ActiveGeneration | null>
  stageGeneration(hostKey: string, result: MobileWebBundleFetchResult): Promise<StagedGeneration>
  commitGeneration(staged: StagedGeneration, owner?: GenerationOwner): Promise<ActiveGeneration>
  abortStagedGeneration(staged: StagedGeneration): Promise<void>
  sweepStagedGenerations(): Promise<void>
  deleteHostCache(hostKey: string, preserveLive?: boolean): Promise<void>
  /** Why an update read failed, kept for Troubleshoot. Never rejects: it is only evidence. */
  recordUpdateFailure(failure: MobileWebShellUpdateFailure): Promise<void>
  /** Oldest first; empty when nothing was recorded or the log cannot be read. */
  readUpdateFailures(): Promise<readonly MobileWebShellUpdateFailure[]>
  /** Keyed by host id, not cache key: the log outlives the host's generations. Never rejects. */
  forgetHostUpdateFailures(hostId: string): Promise<void>
}

/** Host cache keys, least recently used first. Recency only, so anything unreadable degrades to
 *  "evict this host first"; the timestamp record earlier builds wrote reads as empty once. */
const HostOrderSchema = z.array(z.string())

export function createGenerationStore(options: {
  fileSystem: GenerationFileSystem
}): GenerationStore {
  const fs = options.fileSystem
  // `StagedGeneration` is structurally typed, so any object of that shape would otherwise let
  // `commitGeneration` rename over, and `abortStagedGeneration` delete, a directory of the caller's
  // choosing. Only handles this store minted are honoured.
  const issuedHandles = new WeakSet<StagedGeneration>()
  const invalidHosts = new Set<string>()
  const owners = createGenerationOwners(() => {
    void serialize(reclaim).catch(() => undefined)
  })

  const hostRoot = (hostKey: string): string => joinUri(fs.rootUri, requireHostKey(hostKey))
  const generationsRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), GENERATIONS_DIRECTORY_NAME)
  const stagingRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), STAGING_DIRECTORY_NAME)

  async function readHostOrder(): Promise<readonly string[]> {
    // Unreadable is treated as absent here, unlike a manifest: an index nobody can read costs
    // eviction order, and the next activation rewrites it whole.
    const text = await fs.readText(joinUri(fs.rootUri, HOST_INDEX_FILE_NAME)).catch(() => null)
    const parsed = text === null ? null : HostOrderSchema.safeParse(parseJson(text))
    return parsed?.success === true ? parsed.data : []
  }

  async function writeHostOrder(order: readonly string[]): Promise<void> {
    // Recency, not truth: a full disk here must not turn an activation that is already on disk
    // into a thrown commit, and the next activation rewrites the whole index anyway.
    await fs
      .writeText(joinUri(fs.rootUri, HOST_INDEX_FILE_NAME), JSON.stringify(order))
      .catch(() => undefined)
  }

  /** Use without an eviction pass, because the host count did not change. */
  async function touchHost(hostKey: string): Promise<void> {
    const order = await readHostOrder()
    if (order.at(-1) !== hostKey) {
      await writeHostOrder(withHostLast(order, hostKey))
    }
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

  async function enforceHostLimit(order: readonly string[], protectedHost?: string): Promise<void> {
    const hosts = await listActivatedHosts()
    // A host missing from the order sorts first: the index is recency, not truth, so a lost or
    // truncated one costs eviction order rather than a generation. The host just activated is
    // last, so it is never among the evicted.
    const evicted = new Set(
      [...hosts]
        .sort((left, right) => order.indexOf(left) - order.indexOf(right))
        .filter((hostKey) => !owners.holdsHost(hostKey) && hostKey !== protectedHost)
        .slice(0, Math.max(0, hosts.length - MAX_CACHED_HOSTS))
    )
    for (const host of evicted) {
      await dropHostTree(host)
    }
    await writeHostOrder(order.filter((key) => hosts.includes(key) && !evicted.has(key)))
  }

  async function readActive(hostKey: string): Promise<ActiveGeneration | null> {
    if (invalidHosts.has(hostKey)) {
      return null
    }
    const generations = generationsRoot(hostKey)
    const directories = (await fs.list(generations)).filter((entry) => entry.isDirectory)
    if (directories.length === 0) {
      return null
    }
    const selected = await readActiveBuild(fs, hostRoot(hostKey))
    if (selected === INVALID_ACTIVE_BUILD) {
      if (!owners.holdsHost(hostKey)) {
        await dropHostTree(hostKey)
      }
      return null
    }
    const only =
      selected === null
        ? directories.length === 1
          ? directories[0]
          : null
        : (directories.find((entry) => entry.name === selected) ?? null)
    if (only !== null) {
      const directory = joinUri(generations, only.name)
      // Older builds' manifest-next.json is never read; alone it reads as no manifest.
      let text: string | null
      try {
        text = await fs.readText(joinUri(directory, MANIFEST_FILE_NAME))
      } catch {
        // A failed read is not evidence of a bad generation, so nothing is deleted: the caller
        // redownloads, and a transient I/O blip must not cost a cache that verified.
        return null
      }
      const manifest = text === null ? null : parseManifest(text)
      if (manifest !== null && manifest.buildId === only.name) {
        return { buildId: manifest.buildId, directory, manifest }
      }
    }
    if (!owners.holdsHost(hostKey)) {
      await dropHostTree(hostKey)
    }
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

  async function commit(
    staged: StagedGeneration,
    owner?: GenerationOwner
  ): Promise<ActiveGeneration> {
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
      !invalidHosts.has(staged.hostKey) &&
      existing?.isDirectory === true &&
      (await fs.fileExists(joinUri(target, MANIFEST_FILE_NAME)))
    ) {
      // Still an activation: without this a host that redownloads the bundle it already has stays
      // the least recently used and is evicted first.
      await writeActiveBuild(fs, hostRoot(staged.hostKey), staged.buildId)
      invalidHosts.delete(staged.hostKey)
      owners.retain(owner, staged.hostKey, staged.buildId)
      await removeRetired(staged.hostKey, staged.buildId)
      await touchHost(staged.hostKey)
      await fs.delete(staged.directory)
      return active
    }
    // Before any delete: an aborted or swept handle must not cost the live generation, and a tree
    // that is no longer on disk cannot be renamed into one either.
    if (!(await fs.fileExists(joinUri(staged.directory, MANIFEST_FILE_NAME)))) {
      throw new Error(`staged generation ${staged.buildId} is no longer on disk`)
    }
    if (owners.holds(staged.hostKey, staged.buildId)) {
      throw new Error('cannot replace a damaged generation while another view is using it')
    }
    for (const entry of entries) {
      if (!owners.holds(staged.hostKey, entry.name)) {
        await fs.delete(joinUri(generations, entry.name))
      }
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
    await writeActiveBuild(fs, hostRoot(staged.hostKey), staged.buildId)
    invalidHosts.delete(staged.hostKey)
    owners.retain(owner, staged.hostKey, staged.buildId)
    await removeRetired(staged.hostKey, staged.buildId)
    // Enforced here rather than left to a caller: the host ceiling is this module's invariant.
    await enforceHostLimit(withHostLast(await readHostOrder(), staged.hostKey), staged.hostKey)
    return active
  }

  async function openActive(
    hostKey: string,
    owner?: GenerationOwner
  ): Promise<ActiveGeneration | null> {
    const active = await readActive(hostKey)
    // An open is use, so a daily host downloaded long ago is not evicted first.
    if (active !== null) {
      owners.retain(owner, hostKey, active.buildId)
      await touchHost(hostKey)
    }
    return active
  }

  async function removeRetired(hostKey: string, activeBuildId: string): Promise<void> {
    for (const entry of await fs.list(generationsRoot(hostKey))) {
      if (entry.name !== activeBuildId && !owners.holds(hostKey, entry.name)) {
        await fs.delete(joinUri(generationsRoot(hostKey), entry.name))
      }
    }
  }

  async function reclaim(): Promise<void> {
    for (const host of await listHostDirectories()) {
      if (invalidHosts.has(host.name)) {
        await removeRetired(host.name, '')
        if (!owners.holdsHost(host.name)) {
          await dropHostTree(host.name)
          invalidHosts.delete(host.name)
        }
        continue
      }
      const active = await readActive(host.name)
      if (active !== null) {
        await removeRetired(host.name, active.buildId)
      }
    }
    await enforceHostLimit(await readHostOrder())
  }

  async function sweep(): Promise<void> {
    // Every host's `tmp`, not just the one being opened: an interrupted download must not survive a
    // restart, and it may belong to a host this launch never selects.
    for (const host of await listHostDirectories()) {
      await fs.delete(joinUri(fs.rootUri, host.name, STAGING_DIRECTORY_NAME))
    }
    await reclaim()
  }

  async function deleteHost(hostKey: string, preserveLive = false): Promise<void> {
    if (preserveLive && owners.holdsHost(hostKey)) {
      invalidHosts.add(hostKey)
      await invalidateActiveBuild(fs, hostRoot(hostKey))
      await removeRetired(hostKey, '')
      return
    }
    invalidHosts.delete(hostKey)
    await dropHostTree(hostKey)
    const order = await readHostOrder()
    if (order.includes(hostKey)) {
      await writeHostOrder(order.filter((key) => key !== hostKey))
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
    createOwner: owners.create,
    readActiveGeneration: (hostKey, owner) => serialize(() => openActive(hostKey, owner)),
    stageGeneration: (hostKey, result) => serialize(() => stage(hostKey, result)),
    commitGeneration: (staged, owner) => serialize(() => commit(staged, owner)),
    abortStagedGeneration: (staged) =>
      serialize(() => fs.delete(requireIssuedHandle(staged).directory)),
    sweepStagedGenerations: () => serialize(sweep),
    deleteHostCache: (hostKey, preserveLive) => serialize(() => deleteHost(hostKey, preserveLive)),
    recordUpdateFailure: (failure) =>
      serialize(() => recordUpdateFailureIn(fs, failure)).catch(() => undefined),
    readUpdateFailures: () => serialize(() => readUpdateFailureLog(fs)),
    forgetHostUpdateFailures: (hostId) =>
      serialize(() => forgetHostUpdateFailuresIn(fs, hostId)).catch(() => undefined)
  }
}

function withHostLast(order: readonly string[], hostKey: string): string[] {
  return [...order.filter((key) => key !== hostKey), hostKey]
}

/** Read back as loosely as it was accepted: reading a cached manifest strictly would make a field a
 *  newer desktop added a forced redownload on every launch. */
function parseManifest(text: string): MobileWebBundleManifestRead | null {
  const parsed = MobileWebBundleManifestReadSchema.safeParse(parseJson(text))
  return parsed.success ? parsed.data : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
