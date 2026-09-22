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
