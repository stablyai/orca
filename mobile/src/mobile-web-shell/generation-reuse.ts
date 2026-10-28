import {
  sha256HexOf,
  type MobileWebBundleReusableAssets
} from '../transport/mobile-web-bundle-fetch'
import type {
  MobileWebBundleAssetRead,
  MobileWebBundleManifestRead
} from '../transport/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import type { ActiveGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

// Copy immutable, previously hash-verified assets without reading them into JS; match content so renamed assets remain reusable.
function cachedFileOf(
  active: ActiveGeneration | null,
  asset: MobileWebBundleAssetRead
): string | null {
  const cached = active?.manifest.assets.find((entry) => entry.sha256 === asset.sha256)
  return active === null || cached?.byteLength !== asset.byteLength
    ? null
    : joinUri(active.directory, requireStorablePath(cached.path))
}

export function reusableAssetsOf(
  fs: GenerationFileSystem,
  active: ActiveGeneration | null
): Omit<MobileWebBundleReusableAssets, 'keep'> {
  return {
    has: (asset) => {
      try {
        return cachedFileOf(active, asset) !== null
      } catch {
        return false
      }
    },
    check: async (asset) => {
      try {
        const source = cachedFileOf(active, asset)
        return source !== null && (await fs.fileSize(source)) === asset.byteLength
      } catch {
        return false
      }
    }
  }
}

// Stage from the current activation: an intervening commit may have replaced the download’s source. Missing/incomplete copies fail staging so retry checks the new activation.
export async function copyCachedAsset(
  fs: GenerationFileSystem,
  active: ActiveGeneration | null,
  asset: MobileWebBundleAssetRead,
  target: string
): Promise<void> {
  const source = cachedFileOf(active, asset)
  if (source === null) {
    throw new Error(`the cached generation no longer holds the reused asset ${asset.path}`)
  }
  await fs.copyFile(source, target)
  if ((await fs.fileSize(target)) !== asset.byteLength) {
    throw new Error(`the reused asset ${asset.path} did not copy whole`)
  }
}

// Lengths only: a kept file is hashed before reuse, since an interrupted write is what leaves it.
export async function keptAssetPaths(
  fs: GenerationFileSystem,
  directory: string,
  manifest: MobileWebBundleManifestRead
): Promise<ReadonlySet<string>> {
  const kept = new Set<string>()
  for (const asset of manifest.assets) {
    try {
      if (
        (await fs.fileSize(joinUri(directory, requireStorablePath(asset.path)))) ===
        asset.byteLength
      ) {
        kept.add(asset.path)
      }
    } catch {
      // An unreadable or unstorable path is downloaded again.
    }
  }
  return kept
}

// Delete a mismatch so staging, which trusts any whole-length file here, cannot pick it up.
export async function checkKeptAsset(
  fs: GenerationFileSystem,
  directory: string,
  asset: MobileWebBundleAssetRead
): Promise<boolean> {
  const uri = joinUri(directory, requireStorablePath(asset.path))
  try {
    const bytes = await fs.readBytes(uri)
    if (bytes?.byteLength === asset.byteLength && (await sha256HexOf(bytes)) === asset.sha256) {
      return true
    }
  } catch {
    // Unreadable counts as a mismatch.
  }
  await fs.delete(uri).catch(() => undefined)
  return false
}
