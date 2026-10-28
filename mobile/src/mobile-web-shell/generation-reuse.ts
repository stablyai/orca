import type { MobileWebBundleReusableAssets } from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleAssetRead } from '../transport/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import type { ActiveGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

// Copy immutable, previously hash-verified assets without reading them into JS; match content so renamed assets remain reusable.
function cachedFilesOf(
  actives: readonly ActiveGeneration[],
  asset: MobileWebBundleAssetRead
): string[] {
  const files: string[] = []
  for (const active of actives) {
    const cached = active.manifest.assets.find((entry) => entry.sha256 === asset.sha256)
    if (cached?.byteLength === asset.byteLength) {
      files.push(joinUri(active.directory, requireStorablePath(cached.path)))
    }
  }
  return files
}

export function reusableAssetsOf(
  fs: GenerationFileSystem,
  actives: readonly ActiveGeneration[]
): MobileWebBundleReusableAssets {
  return {
    has: (asset) => {
      try {
        return cachedFilesOf(actives, asset).length > 0
      } catch {
        return false
      }
    },
    check: async (asset) => {
      try {
        for (const source of cachedFilesOf(actives, asset)) {
          if ((await fs.fileSize(source).catch(() => null)) === asset.byteLength) {
            return true
          }
        }
        return false
      } catch {
        return false
      }
    }
  }
}

// Stage from the current activation: an intervening commit may have replaced the download’s source. Missing/incomplete copies fail staging so retry checks the new activation.
export async function copyCachedAsset(
  fs: GenerationFileSystem,
  actives: readonly ActiveGeneration[],
  asset: MobileWebBundleAssetRead,
  target: string
): Promise<void> {
  const sources = cachedFilesOf(actives, asset)
  if (sources.length === 0) {
    throw new Error(`the cached generation no longer holds the reused asset ${asset.path}`)
  }
  // An unreadable copy in one host's cache falls through to the next; the last failure fails the stage.
  let failure: unknown
  for (const source of sources) {
    try {
      await fs.delete(target)
      await fs.copyFile(source, target)
      if ((await fs.fileSize(target)) === asset.byteLength) {
        return
      }
      failure = new Error(`the reused asset ${asset.path} did not copy whole`)
    } catch (error) {
      failure = error
    }
  }
  throw failure
}
