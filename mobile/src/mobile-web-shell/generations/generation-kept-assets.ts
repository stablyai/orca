import type { MobileWebBundleReusableAssets } from '../../transport/web-bundle/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import { assetsOnDisk } from './generation-manifest-read'
import type { ActiveGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

// Verified assets of a build still downloading; outside tmp so the launch sweep keeps them for the next attempt.
const KEPT_DIRECTORY_NAME = 'partial'

async function keptBuildIsLive(
  fs: GenerationFileSystem,
  hostRoot: string,
  buildId: string
): Promise<boolean> {
  const builds = await fs.list(joinUri(hostRoot, KEPT_DIRECTORY_NAME))
  return builds.some((entry) => entry.isDirectory && entry.name === buildId)
}

// A cut-off fetch's verified assets of this build; another build's are dropped, since the desktop has moved past it.
async function readKeptAssets(
  fs: GenerationFileSystem,
  hostRoot: string,
  fetching: MobileWebBundleManifestRead
): Promise<ActiveGeneration> {
  // Filtering to files on disk would hide case-aliased paths from the reuse guard, so such a build keeps nothing.
  if (
    new Set(fetching.assets.map((asset) => asset.path.toLowerCase())).size !==
    fetching.assets.length
  ) {
    throw new Error(`build ${fetching.buildId} has case-aliased asset paths`)
  }
  const keptRoot = joinUri(hostRoot, KEPT_DIRECTORY_NAME)
  for (const entry of await fs.list(keptRoot)) {
    if (entry.name !== fetching.buildId) {
      await fs.delete(joinUri(keptRoot, entry.name))
    }
  }
  const directory = joinUri(keptRoot, fetching.buildId)
  await fs.createDirectory(directory)
  const assets = await assetsOnDisk(fs, directory, fetching.assets)
  return { buildId: fetching.buildId, directory, manifest: { ...fetching, assets } }
}

// A fetch naming its build also reuses that build's kept assets, and keeps each asset it verifies.
export async function keepingAssets<Offer extends MobileWebBundleReusableAssets>(
  fs: GenerationFileSystem,
  hostRoot: string,
  fetching: MobileWebBundleManifestRead | undefined,
  enqueue: (write: () => Promise<void>) => Promise<void>,
  open: (kept?: ActiveGeneration) => Promise<Offer>
): Promise<Offer> {
  // Kept assets are a shortcut: without them the fetch still reuses cached builds.
  const kept =
    fetching === undefined
      ? undefined
      : await readKeptAssets(fs, hostRoot, fetching).catch(() => undefined)
  if (kept === undefined) {
    return open()
  }
  return {
    ...(await open(kept)),
    keep: (asset, bytes) => {
      // Best effort, and only while the directory lives: a commit, host removal or newer build ends it.
      void enqueue(async () => {
        if (await keptBuildIsLive(fs, hostRoot, kept.buildId)) {
          await fs.writeBytes(joinUri(kept.directory, requireStorablePath(asset.path)), bytes)
        }
      }).catch(() => undefined)
    }
  }
}

export async function dropKeptAssets(
  fs: GenerationFileSystem,
  hostRoot: string,
  buildId: string
): Promise<void> {
  await fs.delete(joinUri(hostRoot, KEPT_DIRECTORY_NAME, buildId))
}
