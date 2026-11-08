import {
  MobileWebBundleManifestReadSchema,
  type MobileWebBundleManifestRead
} from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import type {
  MobileWebBundleFetchResult,
  MobileWebBundleReusableAssets
} from '../transport/web-bundle/mobile-web-bundle-fetch'
import { joinUri } from './generation-cache-uri'
import { createGenerationHostOrder, parseJson, withHostLast } from './generation-host-order'
import { createDeferredCommits } from './generation-deferred-commits'
import { MANIFEST_FILE_NAME } from './generation-asset-path'
import { reusableAssetsOf, reusableAssetsOfHosts } from './generation-reuse'
import { stagingAssetsOf } from './generation-staging-assets'
import type { GenerationDirectoryEntry, GenerationFileSystem } from './generation-store-file-system'
import { isHostCacheKey } from './host-cache-key'
import type { MobileWebShellUpdateFailure } from './mobile-web-shell-update-failure'
import {
  forgetHostUpdateFailuresIn,
  readUpdateFailureLog,
  recordUpdateFailureIn
} from './mobile-web-shell-update-failure-log'

const GENERATIONS_DIRECTORY_NAME = 'generations'
const STAGING_DIRECTORY_NAME = 'tmp'

export const MAX_CACHED_HOSTS = 6

export type ActiveGeneration = {
  readonly buildId: string
  // The native view reads this tree; only the store may write it.
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
  openReusableAssets(hostKey: string): Promise<MobileWebBundleReusableAssets>
  stageGeneration(
    hostKey: string,
    result: MobileWebBundleFetchResult,
    signal?: AbortSignal,
    reusable?: MobileWebBundleReusableAssets
  ): Promise<StagedGeneration>
  commitGeneration(staged: StagedGeneration): Promise<ActiveGeneration>
  // Commit later: the next readActiveGeneration for this host with no readers commits it, because commit deletes the old build.
  deferCommit(staged: StagedGeneration): void
  // A mounted page reading this host's active build; release when it stops reading it.
  holdGeneration(hostKey: string): () => void
  hasDeferredCommit(hostKey: string, buildId: string): boolean
  abortStagedGeneration(staged: StagedGeneration): Promise<void>
  // Once per store, which is once per launch: a later sweep would delete stages waiting to commit.
  sweepStagedGenerations(): Promise<void>
  deleteHostCache(hostKey: string): Promise<void>
  // Best-effort Troubleshoot evidence; must never reject.
  recordUpdateFailure(failure: MobileWebShellUpdateFailure): Promise<void>
  // Oldest first; unreadable logs count as empty.
  readUpdateFailures(): Promise<readonly MobileWebShellUpdateFailure[]>
  // Key by host id so evidence outlives cached generations; never reject.
  forgetHostUpdateFailures(hostId: string): Promise<void>
}

export function createGenerationStore(options: {
  fileSystem: GenerationFileSystem
}): GenerationStore {
  const fs = options.fileSystem
  const hostOrder = createGenerationHostOrder(fs)
  // Accept only handles minted here; structural lookalikes must not authorize renaming or deleting caller-selected directories.
  const issuedHandles = new WeakSet<StagedGeneration>()
  const reuseSources = new WeakMap<
    MobileWebBundleReusableAssets,
    ReturnType<typeof reusableAssetsOf>
  >()

  const deferred = createDeferredCommits()
  // Only this store writes the tree, so a read answer stays true until it changes it.
  const activeMemo = new Map<string, ActiveGeneration>()
  let swept = false

  const hostRoot = (hostKey: string): string => joinUri(fs.rootUri, requireHostKey(hostKey))
  const generationsRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), GENERATIONS_DIRECTORY_NAME)
  const stagingRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), STAGING_DIRECTORY_NAME)

  async function listHostDirectories(): Promise<readonly GenerationDirectoryEntry[]> {
    const entries = await fs.list(fs.rootUri)
    return entries.filter((entry) => entry.isDirectory && isHostCacheKey(entry.name))
  }

  // Count/evict only hosts with generations; evicting staged-only hosts would delete a tree awaiting commit. Sweeps still visit them.
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
    activeMemo.delete(hostKey)
    deferred.drop(hostKey)
    await fs.delete(hostRoot(hostKey))
  }

  async function enforceHostLimit(order: readonly string[]): Promise<void> {
    const hosts = await listActivatedHosts()
    // Unlisted hosts sort first after index loss; keep the just-activated host last so it survives eviction.
    const evicted = new Set(
      [...hosts]
        .sort((left, right) => order.indexOf(left) - order.indexOf(right))
        .slice(0, Math.max(0, hosts.length - MAX_CACHED_HOSTS))
    )
    for (const host of evicted) {
      await dropHostTree(host)
    }
    await hostOrder.write(order.filter((key) => hosts.includes(key) && !evicted.has(key)))
  }

  async function readActive(
    hostKey: string,
    discardInvalid = true
  ): Promise<ActiveGeneration | null> {
    const generations = generationsRoot(hostKey)
    const directories = (await fs.list(generations)).filter((entry) => entry.isDirectory)
    if (directories.length === 0) {
      return null
    }
    // Multiple generations or a mismatched manifest leave no trustworthy activation; discard the host cache and redownload.
    const only = directories.length === 1 ? directories[0] : null
    if (only !== null) {
      const directory = joinUri(generations, only.name)
      // Ignore legacy manifest-next.json; it cannot prove activation.
      let text: string | null
      try {
        text = await fs.readText(joinUri(directory, MANIFEST_FILE_NAME))
      } catch {
        // Unreadable is not corrupt: preserve verified cache through transient I/O and let the caller redownload.
        return null
      }
      const manifest = text === null ? null : parseManifest(text)
      if (manifest !== null && manifest.buildId === only.name) {
        return { buildId: manifest.buildId, directory, manifest }
      }
    }
    if (discardInvalid) {
      await dropHostTree(hostKey)
    }
    return null
  }

  async function stage(
    hostKey: string,
    result: MobileWebBundleFetchResult,
    signal?: AbortSignal,
    offered?: MobileWebBundleReusableAssets
  ): Promise<StagedGeneration> {
    if (signal?.aborted) {
      throw new Error('generation staging was aborted')
    }
    const manifest = result.manifest
    const directory = joinUri(stagingRoot(hostKey), manifest.buildId)
    const assets = stagingAssetsOf(directory, result)
    // Copy reused assets on the stage queue so sweeps and concurrent downloads cannot remove their source mid-copy.
    let reusable =
      result.reused.length > 0
        ? reuseSources.get(offered ?? (await openReusable(hostKey)))
        : reusableAssetsOf(fs, [])
    if (reusable === undefined) {
      throw new Error('generation store was handed reusable assets it did not issue')
    }
    if (result.reused.length > 0) {
      const current = await readActive(hostKey, false).catch(() => null)
      // A faster same-build download may already have retired the offer's source.
      if (current?.buildId === manifest.buildId) {
        reusable = reusableAssetsOf(fs, [current])
      }
    }
    // Discard prior residue; fresh writes over a partial tree would not form a verified generation.
    await fs.delete(directory)
    try {
      for (const { asset, uri, bytes } of assets) {
        await (bytes === null ? reusable.copyTo(asset, uri) : fs.writeBytes(uri, bytes))
      }
      // Write the manifest last so interrupted trees cannot appear activated.
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
    // Any other stage waiting for this host is older than the build committed now.
    const waiting = deferred.drop(staged.hostKey)
    if (waiting !== null && waiting.directory !== staged.directory) {
      await fs.delete(waiting.directory).catch(() => undefined)
    }
    activeMemo.delete(staged.hostKey)
    const generations = generationsRoot(staged.hostKey)
    const target = joinUri(generations, staged.buildId)
    const active: ActiveGeneration = {
      buildId: staged.buildId,
      directory: target,
      manifest: staged.manifest
    }
    const entries = await fs.list(generations)
    // A build-id directory alone proves nothing: pre-API-26 Android moves can leave it empty. Require its activation manifest before reusing it.
    const existing = entries.find((entry) => entry.name === staged.buildId)
    if (
      existing?.isDirectory === true &&
      (await fs.fileExists(joinUri(target, MANIFEST_FILE_NAME)))
    ) {
      // A same-build redownload still updates recency, or an active host could be evicted first.
      await hostOrder.touch(staged.hostKey)
      await fs.delete(staged.directory)
      return active
    }
    // Verify the stage before deleting live data; aborted/swept handles must not destroy the activation.
    if (!(await fs.fileExists(joinUri(staged.directory, MANIFEST_FILE_NAME)))) {
      throw new Error(`staged generation ${staged.buildId} is no longer on disk`)
    }
    // Delete old generations before rename: a crash then leaves no activation, whereas renaming first can leave two with no way to choose.
    for (const entry of entries) {
      await fs.delete(joinUri(generations, entry.name))
    }
    await fs.createDirectory(generations)
    await fs.moveDirectory(staged.directory, target)
    // Below API 26, Expo Android FileSystemPath.kt moves directories via non-recursive copy/delete and can leave an empty target; failed source deletion leaves tmp for sweeping.
    if (!(await fs.fileExists(joinUri(target, MANIFEST_FILE_NAME)))) {
      await fs.delete(target)
      throw new Error(`generation ${staged.buildId} did not carry its manifest through the rename`)
    }
    await enforceHostLimit(withHostLast(await hostOrder.read(), staged.hostKey))
    return active
  }

  async function commitDeferred(hostKey: string): Promise<void> {
    const waiting = deferred.takeUnread(hostKey)
    if (waiting === null) {
      return
    }
    // A stage that cannot commit is only a missed update; the active build stays and the next entry downloads again.
    await commit(waiting).catch(() => fs.delete(waiting.directory).catch(() => undefined))
  }

  async function openActive(hostKey: string): Promise<ActiveGeneration | null> {
    await commitDeferred(hostKey)
    const active = activeMemo.get(hostKey) ?? (await readActive(hostKey))
    // Opening counts as use even if the host’s bundle was downloaded long ago.
    if (active !== null) {
      activeMemo.set(hostKey, active)
      await hostOrder.touch(hostKey)
    }
    return active
  }

  async function openReusable(hostKey: string): Promise<MobileWebBundleReusableAssets> {
    const hosts = [
      hostKey,
      ...(await listHostDirectories()).map((host) => host.name).filter((key) => key !== hostKey)
    ]
    // Reuse discovery must not clean up another shell's active or staged files.
    const reusable = await reusableAssetsOfHosts(fs, hosts, (key) => readActive(key, false))
    reuseSources.set(reusable, reusable)
    return reusable
  }

  async function sweep(): Promise<void> {
    if (swept) {
      return
    }
    // Sweep every host’s tmp tree; interrupted downloads may belong to a host this launch never opens.
    for (const host of await listHostDirectories()) {
      await fs.delete(joinUri(fs.rootUri, host.name, STAGING_DIRECTORY_NAME))
    }
    swept = true
  }

  async function deleteHost(hostKey: string): Promise<void> {
    await dropHostTree(hostKey)
    const order = await hostOrder.read()
    if (order.includes(hostKey)) {
      await hostOrder.write(order.filter((key) => key !== hostKey))
    }
  }

  // Serialize across the whole store to order stage/commit/sweep/delete and keep same-build staging writes contiguous.
  let tail: Promise<unknown> = Promise.resolve()
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(operation, operation)
    tail = run.catch(() => undefined)
    return run
  }

  return {
    readActiveGeneration: (hostKey) => serialize(() => openActive(hostKey)),
    openReusableAssets: (hostKey) => serialize(() => openReusable(hostKey)),
    stageGeneration: (hostKey, result, signal, reusable) =>
      serialize(() => stage(hostKey, result, signal, reusable)),
    commitGeneration: (staged) => serialize(() => commit(staged)),
    deferCommit: (staged) => {
      const replaced = deferred.defer(requireIssuedHandle(staged))
      if (replaced !== null) {
        void serialize(() => fs.delete(replaced.directory)).catch(() => undefined)
      }
    },
    holdGeneration: deferred.hold,
    hasDeferredCommit: deferred.waits,
    abortStagedGeneration: (staged) =>
      serialize(() => fs.delete(requireIssuedHandle(staged).directory)),
    sweepStagedGenerations: () => serialize(sweep),
    deleteHostCache: (hostKey) => serialize(() => deleteHost(hostKey)),
    recordUpdateFailure: (failure) =>
      serialize(() => recordUpdateFailureIn(fs, failure)).catch(() => undefined),
    readUpdateFailures: () => serialize(() => readUpdateFailureLog(fs)),
    forgetHostUpdateFailures: (hostId) =>
      serialize(() => forgetHostUpdateFailuresIn(fs, hostId)).catch(() => undefined)
  }
}

// Use the forward-compatible reader on disk too; newer desktop fields must not force redownload every launch.
function parseManifest(text: string): MobileWebBundleManifestRead | null {
  const parsed = MobileWebBundleManifestReadSchema.safeParse(parseJson(text))
  return parsed.success ? parsed.data : null
}

function requireHostKey(hostKey: string): string {
  if (!isHostCacheKey(hostKey)) {
    throw new Error('generation store was handed something that is not a host cache key')
  }
  return hostKey
}
