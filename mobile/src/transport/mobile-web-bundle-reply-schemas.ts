import { z } from 'zod'
import { MOBILE_WEB_BUNDLE_CHUNK_BYTES } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  MobileWebBundleAssetPathSchema,
  MOBILE_WEB_BUNDLE_MAX_ASSETS,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS,
  MOBILE_WEB_BUNDLE_MAX_ROUTES,
  MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES
} from '../../../src/shared/mobile-web-bundle/manifest-contract'

// Hoisted, never built inside a reader: a schema constructed per parse cost 2275 ns against 156 ns
// for the same shape hoisted (#21311).
//
// Loose where the host contract is strict, and required only where this client reads. The host's
// own schemas describe what it produces and stay `.strict()`; a phone that rejected an unknown
// member would turn a later optional field into a released-client break instead of the Rule 1
// addition `docs/reference/remote-wire-compatibility.md` allows.

/** Lowercase hex digest. The shared contract keeps its copy private, so this is the one place the
 *  client states the shape it accepts. */
const SHA256_PATTERN = /^[a-f0-9]{64}$/

/** Base64 of one chunk, bounded by the same arithmetic as `skill-upload-session-contract.ts`, so a
 *  host that overshoots is refused at the boundary instead of at reassembly. */
const MAX_DATA_BASE64_LENGTH = Math.ceil(MOBILE_WEB_BUNDLE_CHUNK_BYTES / 3) * 4 + 8

/** A screen the desktop asks this shell to render from the bundle. Optional, because a desktop
 *  older than the field sends none and every route then stays native, which is where they all
 *  start. Loose for the same reason the manifest is: a grant name this build does not know is not a
 *  reason to refuse a bundle, it is a reason to leave that one route native. */
const pageRouteSchema = z.looseObject({
  pathname: z.string().min(1).max(255),
  grants: z.array(z.string().min(1).max(64)).max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
})

const assetSchema = z.looseObject({
  path: MobileWebBundleAssetPathSchema,
  sha256: z.string().regex(SHA256_PATTERN),
  byteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  contentType: z.string().min(1)
})

/** Everything the fetch reads: the id it caches under, the assets it pages, and the entry it will
 *  later load, plus the protocol window the update wall compares against the host.
 *  `desktopVersion` still passes through untyped; nothing reads it yet.
 *
 *  `schemaVersion` is read as a number, not pinned to the one this shell knows: refusing it here
 *  would fail the parse before `evaluateMobileWebBundleCompat` could name the shell as too old, and
 *  an unreadable schema is a wall to show, not a shape to guess at. The manifest stays closed in
 *  both directions on the host's side, where it is written.
 *
 *  Exported because the generation store re-parses the manifest it cached, and reading it back
 *  strictly after accepting it loosely would make a host's added field a forced redownload on every
 *  launch. */
export const MobileWebBundleManifestReadSchema = z
  .looseObject({
    schemaVersion: z.number().int(),
    buildId: z.string().regex(SHA256_PATTERN),
    minCompatibleRuntimeProtocolVersion: z.number().int().nonnegative(),
    runtimeProtocolVersion: z.number().int().nonnegative(),
    entrypoint: MobileWebBundleAssetPathSchema,
    totalBytes: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES),
    assets: z.array(assetSchema).min(1).max(MOBILE_WEB_BUNDLE_MAX_ASSETS),
    routes: z.array(pageRouteSchema).max(MOBILE_WEB_BUNDLE_MAX_ROUTES).optional()
  })
  // The allocation bound, and the reason it is the sum rather than `totalBytes`: the fetch
  // allocates one buffer per asset from `byteLength` and holds them all, so a manifest declaring
  // `totalBytes` 0 alongside 256 assets of 10 MiB each would pass every ceiling above and still
  // cost 2560 MiB. The host pins sum === totalBytes; this client never trusts `totalBytes` for
  // anything, so it bounds what it will actually allocate instead.
  .refine(
    (manifest) =>
      manifest.assets.reduce((sum, asset) => sum + asset.byteLength, 0) <=
      MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES,
    'assets sum to more than the contract total'
  )

/** `chunkBytes` is read, never assumed: the host may shrink it without a client release. Capped at
 *  the constant because a larger value would overshoot `dataBase64` above. */
export const MobileWebBundleManifestReplySchema = z.looseObject({
  manifest: MobileWebBundleManifestReadSchema,
  chunkBytes: z.number().int().positive().max(MOBILE_WEB_BUNDLE_CHUNK_BYTES)
})

/** Self-describing on purpose: `buildId`, `path` and `offset` are echoed so a reassembler cannot
 *  misplace a reply, and `sha256`/`assetByteLength` describe the whole asset rather than this
 *  chunk, which is what lets the fetch verify without a second index. */
export const MobileWebBundleChunkReplySchema = z.looseObject({
  buildId: z.string().regex(SHA256_PATTERN),
  path: MobileWebBundleAssetPathSchema,
  offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  assetByteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
  dataBase64: z.string().max(MAX_DATA_BASE64_LENGTH),
  eof: z.boolean()
})

export type MobileWebBundleManifestReply = z.output<typeof MobileWebBundleManifestReplySchema>
export type MobileWebBundleManifestRead = MobileWebBundleManifestReply['manifest']
export type MobileWebBundleAssetRead = MobileWebBundleManifestRead['assets'][number]
