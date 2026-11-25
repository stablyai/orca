import type { MobileWebBundleAssetRead } from './mobile-web-bundle-reply-schemas'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import type { MobileWebBundleWindowHeader } from './mobile-web-bundle-window-reader'

/** The file the windows are cut from: the asset, or its brotli copy. */
export type MobileWebBundleWindowStream = Pick<MobileWebBundleAssetRead, 'path' | 'byteLength'>

export function windowSlotBytes(
  entry: MobileWebBundleWindowStream,
  offset: number,
  windowBytes: number
): number {
  return Math.min(windowBytes, entry.byteLength - offset)
}

/** Offsets are planned, so a reply is accepted only if it fills exactly its slot of the grid. */
export function assertWindowFillsItsSlot(
  entry: MobileWebBundleWindowStream,
  offset: number,
  byteLength: number,
  eof: boolean,
  windowBytes: number
): void {
  const { path, byteLength: declared } = entry
  const expected = windowSlotBytes(entry, offset, windowBytes)
  if (byteLength === expected && eof === offset + windowBytes >= declared) {
    return
  }
  const end = offset + byteLength
  if (byteLength > windowBytes) {
    throw new MobileWebBundleFetchError(
      'chunk-oversize',
      `bundle window for ${path} at ${offset} is ${byteLength} bytes, over the ${windowBytes}-byte window`
    )
  }
  if (byteLength > expected || (byteLength > 0 && !eof && end >= declared)) {
    throw new MobileWebBundleFetchError(
      'asset-overlong',
      `bundle asset ${path} is longer than the manifest declares`
    )
  }
  if (!eof && byteLength === 0) {
    throw new MobileWebBundleFetchError(
      'asset-no-progress',
      `bundle asset ${path} made no progress at ${offset}`
    )
  }
  throw new MobileWebBundleFetchError(
    'asset-short',
    eof
      ? `bundle asset ${path} ended at ${end} of ${declared} declared bytes`
      : `bundle window for ${path} at ${offset} carried ${byteLength} of ${expected} bytes without ending the asset`
  )
}

// Validate build/path/offset/length/hash echoes so misrouted or post-update replies cannot corrupt reassembly.
export function assertWindowDescribesAsset(
  reply: MobileWebBundleWindowHeader,
  asset: MobileWebBundleAssetRead,
  buildId: string,
  offset: number
): void {
  if (reply.buildId !== buildId) {
    throw new MobileWebBundleFetchError(
      'build-changed-mid-fetch',
      `bundle build changed mid-fetch: asked ${buildId}, served ${reply.buildId}`
    )
  }
  if (reply.path !== asset.path || reply.offset !== offset) {
    throw new MobileWebBundleFetchError(
      'chunk-misrouted',
      `bundle window answered ${reply.path} at ${reply.offset}, not ${asset.path} at ${offset}`
    )
  }
  if (reply.sha256 !== asset.sha256 || reply.assetByteLength !== asset.byteLength) {
    throw new MobileWebBundleFetchError(
      'asset-entry-changed',
      `bundle asset ${asset.path} no longer matches the manifest entry`
    )
  }
}
