/** What the fetch refused about the bytes that arrived. The message names asset paths and hashes;
 *  this code is the part a caller may keep. */
export const MOBILE_WEB_BUNDLE_FETCH_REFUSALS = [
  'chunk-oversize',
  'asset-overlong',
  'asset-no-progress',
  'asset-short',
  'asset-checksum-mismatch',
  'build-changed-mid-fetch',
  'chunk-misrouted',
  'asset-entry-changed',
  /** A range body that would not decode: corrupt or truncated gzip, or an encoding this build lacks. */
  'range-undecodable',
  'fetch-stopped'
] as const

export type MobileWebBundleFetchRefusal = (typeof MOBILE_WEB_BUNDLE_FETCH_REFUSALS)[number]

export class MobileWebBundleFetchError extends Error {
  constructor(
    readonly refusal: MobileWebBundleFetchRefusal,
    message: string
  ) {
    super(message)
    this.name = 'MobileWebBundleFetchError'
  }
}
