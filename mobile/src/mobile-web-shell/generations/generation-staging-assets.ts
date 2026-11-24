import type { MobileWebBundleFetchResult } from '../../transport/web-bundle/mobile-web-bundle-fetch'
import {
  isDeferredAsset,
  shellDownloadedAssets
} from '../../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'

export function stagingAssetsOf(directory: string, result: MobileWebBundleFetchResult) {
  const reused = new Set(result.reused)
  // Deferred code the fetch found in a cached build is reused too.
  const deferred = result.manifest.assets.filter(
    (asset) => isDeferredAsset(asset) && reused.has(asset.path)
  )
  return [...shellDownloadedAssets(result.manifest), ...deferred].map((asset) => ({
    asset,
    uri: joinUri(directory, requireStorablePath(asset.path)),
    bytes: reused.has(asset.path) ? null : requireExactBytes(result.assets.get(asset.path), asset)
  }))
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
