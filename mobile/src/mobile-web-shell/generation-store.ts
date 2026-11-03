import { z } from 'zod'
import type {
  MobileWebBundleFetchResult,
  MobileWebBundleReusableAssets
} from '../transport/web-bundle/mobile-web-bundle-fetch'
import { joinUri } from './generation-cache-uri'
import { MANIFEST_FILE_NAME } from './generation-asset-path'
import { reusableAssetsOf, reusableAssetsOfHosts } from './generation-reuse'
import { stagingAssetsOf } from './generation-staging-assets'
import type { GenerationDirectoryEntry, GenerationFileSystem } from './generation-store-file-system'
import { isHostCacheKey } from './host-cache-key'
import { createGenerationActivation } from './generation-activation'
import {
  forgetHostUpdateFailuresIn,
  readUpdateFailureLog,
  recordUpdateFailureIn
} from './mobile-web-shell-update-failure-log'

const GENERATIONS_DIRECTORY_NAME = 'generations'
const STAGING_DIRECTORY_NAME = 'tmp'
const HOST_INDEX_FILE_NAME = 'hosts.json'

export const MAX_CACHED_HOSTS = 6

export type {
  ActiveGeneration,
  GenerationLease,
  GenerationStore,
  StagedGeneration
} from './generation-store-contract'
import type {
  ActiveGeneration,
  GenerationLease,
  GenerationStore,
  StagedGeneration
} from './generation-store-contract'

// Recency only: unreadable or legacy timestamp indexes count as empty, making unlisted hosts first to evict.
const HostOrderSchema = z.array(z.string())

export function createGenerationStore(options: {
  fileSystem: GenerationFileSystem
}): GenerationStore {
  const fs = options.fileSystem
  // Accept only handles minted here; structural lookalikes must not authorize renaming or deleting caller-selected directories.
  const issuedHandles = new WeakSet<StagedGeneration>()
  const activation = createGenerationActivation(fs)
  let evictionDeferred = false
  const stages = new Set<StagedGeneration>()
  const stageEpochs = new WeakMap<StagedGeneration, number>()
  const hostEpochs = new Map<string, number>()
  const reuseSources = new WeakMap<
    MobileWebBundleReusableAssets,
    ReturnType<typeof reusableAssetsOf>
  >()

  const hostRoot = (hostKey: string): string => joinUri(fs.rootUri, requireHostKey(hostKey))
  const stagingRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), STAGING_DIRECTORY_NAME)

  async function readHostOrder(): Promise<readonly string[]> {
    // Index read failures lose eviction order only; the next activation rewrites it.
    const text = await fs.readText(joinUri(fs.rootUri, HOST_INDEX_FILE_NAME)).catch(() => null)
    const parsed = text === null ? null : HostOrderSchema.safeParse(parseJson(text))
    return parsed?.success === true ? parsed.data : []
  }

  async function writeHostOrder(order: readonly string[]): Promise<void> {
    // Index write failures must not reject an activation already on disk; the next activation rewrites it.
    await fs
      .writeText(joinUri(fs.rootUri, HOST_INDEX_FILE_NAME), JSON.stringify(order))
      .catch(() => undefined)
  }

  // No eviction pass: touching recency does not add a host.
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
    activation.revokeHost(hostKey)
    hostEpochs.set(hostKey, (hostEpochs.get(hostKey) ?? 0) + 1)
    for (const staged of stages) {
      if (staged.hostKey === hostKey) {
        stages.delete(staged)
      }
    }
    await fs.delete(hostRoot(hostKey))
  }

  function hostOwned(hostKey: string): boolean {
    return activation.hasLive(hostKey) || [...stages].some((staged) => staged.hostKey === hostKey)
  }

  async function enforceHostLimit(order: readonly string[]): Promise<void> {
    const hosts = await listActivatedHosts()
    // Unlisted hosts sort first after index loss; keep the just-activated host last so it survives eviction.
    const evicted = new Set(
      [...hosts]
        .filter((host) => !hostOwned(host))
        .sort((left, right) => order.indexOf(left) - order.indexOf(right))
        .slice(0, Math.max(0, hosts.length - MAX_CACHED_HOSTS))
    )
    evictionDeferred = hosts.length - evicted.size > MAX_CACHED_HOSTS
    for (const host of evicted) {
      await dropHostTree(host)
    }
    await writeHostOrder(order.filter((key) => hosts.includes(key) && !evicted.has(key)))
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
      const current = await activation.readActive(hostKey).catch(() => null)
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
    stages.add(handle)
    stageEpochs.set(handle, hostEpochs.get(hostKey) ?? 0)
    return handle
  }

  function requireIssuedHandle(staged: StagedGeneration): StagedGeneration {
    if (!issuedHandles.has(staged)) {
      throw new Error('generation store was handed a staged handle it did not issue')
    }
    if (stageEpochs.get(staged) !== (hostEpochs.get(staged.hostKey) ?? 0)) {
      throw new Error('staged generation belongs to a removed host')
    }
    return staged
  }

  async function openActive(hostKey: string): Promise<ActiveGeneration | null> {
    const active = await activation.readActive(hostKey)
    // Opening counts as use even if the host’s bundle was downloaded long ago.
    if (active !== null) {
      await touchHost(hostKey)
    }
    return active
  }

  async function openReusable(hostKey: string): Promise<MobileWebBundleReusableAssets> {
    const hosts = [
      hostKey,
      ...(await listHostDirectories()).map((host) => host.name).filter((key) => key !== hostKey)
    ]
    // Reuse discovery must not clean up another shell's active or staged files.
    const reusable = await reusableAssetsOfHosts(fs, hosts, (key) => activation.readActive(key))
    reuseSources.set(reusable, reusable)
    return reusable
  }

  async function sweep(): Promise<void> {
    for (const host of await listHostDirectories()) {
      const root = stagingRoot(host.name)
      for (const entry of await fs.list(root)) {
        const directory = joinUri(root, entry.name)
        if (![...stages].some((staged) => staged.directory === directory)) {
          await fs.delete(directory)
        }
      }
      if ((await fs.list(root)).length === 0) {
        await fs.delete(root)
      }
      await activation.cleanGenerations(host.name).catch(() => undefined)
    }
  }

  async function deleteHost(hostKey: string): Promise<void> {
    await dropHostTree(hostKey)
    const order = await readHostOrder()
    if (order.includes(hostKey)) {
      await writeHostOrder(order.filter((key) => key !== hostKey))
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
    acquireGeneration: (hostKey, generation) =>
      serialize(() => activation.acquire(hostKey, generation)),
    releaseGeneration: (lease) => {
      activation.release(lease)
      if (evictionDeferred) {
        void serialize(() => readHostOrder().then(enforceHostLimit)).catch(() => undefined)
      }
    },
    confirmGeneration: (lease, isCurrentDocument) =>
      serialize(() => activation.confirm(lease, isCurrentDocument)),
    rejectGeneration: (lease) => serialize(() => activation.reject(lease)),
    readActiveGeneration: (hostKey) => serialize(() => openActive(hostKey)),
    openReusableAssets: (hostKey) => serialize(() => openReusable(hostKey)),
    stageGeneration: (hostKey, result, signal, reusable) =>
      serialize(() => stage(hostKey, result, signal, reusable)),
    commitGeneration: (staged) =>
      serialize(async () => {
        let lease: GenerationLease | null = null
        try {
          requireIssuedHandle(staged)
          const active = await activation.commit(staged)
          lease = await activation.acquire(staged.hostKey, active)
          if (lease === null) {
            throw new Error('published generation is no longer available')
          }
          stages.delete(staged)
          await enforceHostLimit(withHostLast(await readHostOrder(), staged.hostKey))
          return lease
        } catch (error) {
          if (lease !== null) {
            activation.release(lease)
          }
          stages.delete(staged)
          if (evictionDeferred) {
            await readHostOrder()
              .then(enforceHostLimit)
              .catch(() => undefined)
          }
          throw error
        }
      }),
    abortStagedGeneration: (staged) =>
      serialize(async () => {
        await fs.delete(requireIssuedHandle(staged).directory)
        stages.delete(staged)
        if (evictionDeferred) {
          await enforceHostLimit(await readHostOrder())
        }
      }),
    sweepStagedGenerations: () => serialize(sweep),
    deleteHostCache: (hostKey) => serialize(() => deleteHost(hostKey)),
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
