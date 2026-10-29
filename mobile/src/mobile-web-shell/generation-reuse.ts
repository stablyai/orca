import type { MobileWebBundleReusableAssets } from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleAssetRead } from '../transport/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import type { ActiveGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

type ReusableGenerationAssets = MobileWebBundleReusableAssets & {
  copyTo(asset: MobileWebBundleAssetRead, target: string): Promise<void>
}

// Copy immutable, previously hash-verified assets without reading them into JS; match content so renamed assets remain reusable.
export function reusableAssetsOf(
  fs: GenerationFileSystem,
  active: ActiveGeneration | null
): ReusableGenerationAssets {
  const byHash = new Map<string, MobileWebBundleAssetRead>()
  for (const entry of active?.manifest.assets ?? []) {
    const { sha256 } = entry
    if (!byHash.has(sha256)) {
      byHash.set(sha256, entry)
    }
  }
  const cachedFileOf = (asset: MobileWebBundleAssetRead): string | null => {
    const cached = byHash.get(asset.sha256)
    return active === null || cached?.byteLength !== asset.byteLength
      ? null
      : joinUri(active.directory, requireStorablePath(cached.path))
  }
  return {
    has: (asset) => {
      try {
        return cachedFileOf(asset) !== null
      } catch {
        return false
      }
    },
    check: async (asset) => {
      try {
        const source = cachedFileOf(asset)
        return source !== null && (await fs.fileSize(source)) === asset.byteLength
      } catch {
        return false
      }
    },
    // Stage from the current activation: an intervening commit may have replaced the download's source.
    copyTo: async (asset, target) => {
      const source = cachedFileOf(asset)
      if (source === null) {
        throw new Error(`the cached generation no longer holds the reused asset ${asset.path}`)
      }
      await fs.copyFile(source, target)
      if ((await fs.fileSize(target)) !== asset.byteLength) {
        throw new Error(`the reused asset ${asset.path} did not copy whole`)
      }
    }
  }
}
