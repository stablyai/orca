import {
  MobileWebBundleManifestReadSchema,
  type MobileWebBundleManifestRead
} from '../transport/mobile-web-bundle-reply-schemas'
import type {
  MobileWebBundleFetchResult,
  MobileWebBundleReusableAssets
} from '../transport/mobile-web-bundle-fetch'
import { joinUri } from './generation-cache-uri'
import { MANIFEST_FILE_NAME, requireStorablePath } from './generation-asset-path'
import {
  checkKeptAsset,
  copyCachedAsset,
  keptAssetPaths,
  reusableAssetsOf
} from './generation-reuse'
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
  // Drops the host's interrupted downloads of other builds: at most one build per host is ever resumable.
  openReusableAssets(
    hostKey: string,
    manifest: MobileWebBundleManifestRead
  ): Promise<MobileWebBundleReusableAssets>
  stageGeneration(hostKey: string, result: MobileWebBundleFetchResult): Promise<StagedGeneration>
  commitGeneration(staged: StagedGeneration): Promise<ActiveGeneration>
  // Keeps the staged files so the next attempt at this build resumes from them.
  abortStagedGeneration(staged: StagedGeneration): Promise<void>
  deleteHostCache(hostKey: string): Promise<void>
  // Bundles live as long as their pairing; a rejected read skips the sweep rather than guess.
  deleteUnpairedHostCaches(readPairedHostKeys: () => Promise<ReadonlySet<string>>): Promise<void>
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
  // Accept only handles minted here; structural lookalikes must not authorize renaming or deleting caller-selected directories.
  const issuedHandles = new WeakSet<StagedGeneration>()

  const hostRoot = (hostKey: string): string => joinUri(fs.rootUri, requireHostKey(hostKey))
  const generationsRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), GENERATIONS_DIRECTORY_NAME)
  const stagingRoot = (hostKey: string): string =>
    joinUri(hostRoot(hostKey), STAGING_DIRECTORY_NAME)

  async function listHostDirectories(): Promise<readonly GenerationDirectoryEntry[]> {
    const entries = await fs.list(fs.rootUri)
    return entries.filter((entry) => entry.isDirectory && isHostCacheKey(entry.name))
  }

  async function dropHostTree(hostKey: string): Promise<void> {
    await fs.delete(hostRoot(hostKey))
  }

  async function readActive(hostKey: string): Promise<ActiveGeneration | null> {
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
    await dropHostTree(hostKey)
    return null
  }

  async function stage(
    hostKey: string,
    result: MobileWebBundleFetchResult
  ): Promise<StagedGeneration> {
    const manifest = result.manifest
    const directory = joinUri(stagingRoot(hostKey), manifest.buildId)
    const reused = new Set(result.reused)
    const assets = manifest.assets.map((asset) => ({
      asset,
      uri: joinUri(directory, requireStorablePath(asset.path)),
      bytes: reused.has(asset.path) ? null : requireExactBytes(result.assets.get(asset.path), asset)
    }))
    // Copy reused assets on the stage queue so concurrent downloads cannot remove their source mid-copy.
    const active = reused.size > 0 ? await readActive(hostKey) : null
    // A failure leaves the written files: every whole-length file here holds verified bytes the next attempt can resume from.
    for (const { asset, uri, bytes } of assets) {
      if (bytes !== null) {
        await fs.writeBytes(uri, bytes)
      } else if ((await fs.fileSize(uri)) !== asset.byteLength) {
        await fs.delete(uri)
        await copyCachedAsset(fs, active, asset, uri)
      }
    }
    // Write the manifest last so interrupted trees cannot appear activated.
    await fs.writeText(joinUri(directory, MANIFEST_FILE_NAME), JSON.stringify(manifest))
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
    // A build-id directory alone proves nothing: pre-API-26 Android moves can leave it empty. Require its activation manifest before reusing it.
    const existing = entries.find((entry) => entry.name === staged.buildId)
    if (
      existing?.isDirectory === true &&
      (await fs.fileExists(joinUri(target, MANIFEST_FILE_NAME)))
    ) {
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
    // Below API 26, Expo Android FileSystemPath.kt moves directories via non-recursive copy/delete and can leave an empty target; failed source deletion leaves a tmp tree the host's next download of another build discards.
    if (!(await fs.fileExists(joinUri(target, MANIFEST_FILE_NAME)))) {
      await fs.delete(target)
      throw new Error(`generation ${staged.buildId} did not carry its manifest through the rename`)
    }
    return active
  }

  async function openReusable(
    hostKey: string,
    manifest: MobileWebBundleManifestRead
  ): Promise<MobileWebBundleReusableAssets> {
    const active = reusableAssetsOf(fs, await readActive(hostKey))
    const staging = stagingRoot(hostKey)
    for (const entry of await fs.list(staging)) {
      if (entry.name !== manifest.buildId) {
        // A stuck folder costs space, not this download's reuse of the active generation.
        await fs.delete(joinUri(staging, entry.name)).catch(() => undefined)
      }
    }
    const directory = joinUri(staging, manifest.buildId)
    const kept = await keptAssetPaths(fs, directory, manifest)
    return {
      has: (asset) => kept.has(asset.path) || active.has(asset),
      check: async (asset) =>
        (kept.has(asset.path) && (await serialize(() => checkKeptAsset(fs, directory, asset)))) ||
        (await active.check(asset)),
      keep: (asset, bytes) =>
        serialize(() =>
          fs.writeBytes(joinUri(directory, requireStorablePath(asset.path)), bytes)
        ).then(
          () => true,
          () => false
        )
    }
  }

  async function deleteUnpairedHosts(
    readPairedHostKeys: () => Promise<ReadonlySet<string>>
  ): Promise<void> {
    // Read inside the queue: a host paired later can only stage after this sweep finishes.
    const paired = await readPairedHostKeys()
    for (const host of await listHostDirectories()) {
      if (!paired.has(host.name)) {
        // One undeletable folder must not keep the rest.
        await dropHostTree(host.name).catch(() => undefined)
      }
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
    readActiveGeneration: (hostKey) => serialize(() => readActive(hostKey)),
    openReusableAssets: (hostKey, manifest) => serialize(() => openReusable(hostKey, manifest)),
    stageGeneration: (hostKey, result) => serialize(() => stage(hostKey, result)),
    commitGeneration: (staged) => serialize(() => commit(staged)),
    abortStagedGeneration: (staged) =>
      serialize(() =>
        fs.delete(joinUri(requireIssuedHandle(staged).directory, MANIFEST_FILE_NAME))
      ),
    deleteHostCache: (hostKey) => serialize(() => dropHostTree(hostKey)),
    deleteUnpairedHostCaches: (readPairedHostKeys) =>
      serialize(() => deleteUnpairedHosts(readPairedHostKeys)),
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

function requireExactBytes(
  bytes: Uint8Array | undefined,
  asset: { path: string; byteLength: number }
): Uint8Array {
  // Validate all downloaded assets before any write so absent/wrong-length bytes never enter staging.
  if (bytes === undefined || bytes.byteLength !== asset.byteLength) {
    throw new Error(
      `bundle asset ${asset.path} is ${bytes?.byteLength ?? 'absent'}, not the manifest's ${asset.byteLength}`
    )
  }
  return bytes
}
