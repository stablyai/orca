import { serializeMobileWebBundleAssets } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'

/** Refused rather than thrown: a manifest the store will not write is freshness the caller loses,
 *  never a failure of the generation already on disk. */
export type ManifestPersistRefusal =
  | 'refused-no-active-generation'
  | 'refused-build-mismatch'
  | 'refused-asset-mismatch'

export type ManifestPersistOutcome = 'persisted' | ManifestPersistRefusal

/**
 * Why this manifest may not be written onto the generation on disk, or null when it may.
 *
 * The asset list, not just the id: the build id is a digest of exactly that list, so a manifest
 * claiming the id while naming other bytes is a different bundle however it arrived, and writing it
 * would leave a cached generation described by a manifest its own files do not answer. Compared
 * through the contract's own serializer, which is the string the id is computed from, so the two
 * cannot disagree about what counts as the same assets.
 *
 * This is the phone's own check, not a restatement of one it has already made. The refine that
 * pins `buildId` to `computeMobileWebBundleId(assets)` is on the host's `.strict()` schema in
 * `src/shared/mobile-web-bundle/manifest-contract.ts`; the phone reads the same document loosely
 * (`mobile-web-bundle-reply-schemas.ts`) and never recomputes the digest, so nothing before this
 * line has compared a manifest's id to the bytes it names.
 */
export function refuseManifestPersist(
  stored: MobileWebBundleManifestRead,
  fresh: MobileWebBundleManifestRead
): ManifestPersistRefusal | null {
  if (stored.buildId !== fresh.buildId) {
    return 'refused-build-mismatch'
  }
  return serializeMobileWebBundleAssets(stored.assets) ===
    serializeMobileWebBundleAssets(fresh.assets)
    ? null
    : 'refused-asset-mismatch'
}
