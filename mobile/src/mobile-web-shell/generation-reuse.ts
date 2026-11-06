import type { MobileWebBundleReusableAssets } from '../transport/web-bundle/mobile-web-bundle-fetch'
import type { MobileWebBundleAssetRead } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import type { ActiveGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

type ReusableGenerationAssets = MobileWebBundleReusableAssets & {
  copyTo(asset: MobileWebBundleAssetRead, target: string): Promise<void>
}

export async function reusableAssetsOfHosts(
  fs: GenerationFileSystem,
  hostKeys: readonly string[],
  readGeneration: (hostKey: string) => Promise<ActiveGeneration | null>
): Promise<ReusableGenerationAssets> {
  const generations: ActiveGeneration[] = []
  for (const host of hostKeys) {
    const active = await readGeneration(host).catch(() => null)
    if (active !== null) {
      generations.push(active)
    }
  }
  return reusableAssetsOf(fs, generations)
}

// Copy immutable, previously hash-verified assets without reading them into JS; match content so renamed assets remain reusable.
export function reusableAssetsOf(
  fs: GenerationFileSystem,
  generations: readonly ActiveGeneration[]
): ReusableGenerationAssets {
  const byHash = new Map<string, { directory: string; asset: MobileWebBundleAssetRead }[]>()
  for (const generation of generations) {
    // Aliased paths can have overwritten verified bytes under a different manifest hash.
    const paths = generation.manifest.assets.map((asset) => asset.path.toLowerCase())
    if (new Set(paths).size !== paths.length) {
      continue
    }
    const seen = new Set<string>()
    for (const asset of generation.manifest.assets) {
      const { sha256 } = asset
      if (seen.has(sha256)) {
        continue
      }
      seen.add(sha256)
      const sources = byHash.get(sha256) ?? []
      sources.push({ directory: generation.directory, asset })
      byHash.set(sha256, sources)
    }
  }
  const cachedFilesOf = (asset: MobileWebBundleAssetRead): string[] => {
    const sources: string[] = []
    for (const cached of byHash.get(asset.sha256) ?? []) {
      if (cached.asset.byteLength === asset.byteLength) {
        try {
          sources.push(joinUri(cached.directory, requireStorablePath(cached.asset.path)))
        } catch {
          // An unstorable cached path cannot supply a reusable file.
        }
      }
    }
    return sources
  }
  return {
    has: (asset) => cachedFilesOf(asset).length > 0,
    check: async (asset) => {
      for (const source of cachedFilesOf(asset)) {
        if ((await fs.fileSize(source).catch(() => null)) === asset.byteLength) {
          return true
        }
      }
      return false
    },
    // Copy from this offer's snapshot while the store queue protects its surviving sources.
    copyTo: async (asset, target) => {
      let failure = new Error(
        `the cached generation no longer holds the reused asset ${asset.path}`
      )
      for (const source of cachedFilesOf(asset)) {
        try {
          await fs.copyFile(source, target)
          if ((await fs.fileSize(target)) !== asset.byteLength) {
            throw new Error(`the reused asset ${asset.path} did not copy whole`)
          }
          return
        } catch (error) {
          await fs.delete(target)
          if (error instanceof Error) {
            failure = error
          }
        }
      }
      throw failure
    }
  }
}
