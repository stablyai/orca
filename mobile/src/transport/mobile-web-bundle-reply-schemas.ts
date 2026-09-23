import { z } from 'zod'
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH
} from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  computeMobileWebBundleId,
  MobileWebBundleAssetPathSchema,
  MOBILE_WEB_BUNDLE_MAX_ASSETS,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS,
  MOBILE_WEB_BUNDLE_MAX_ROUTES,
  MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES,
  SHA256_PATTERN
} from '../../../src/shared/mobile-web-bundle/manifest-contract'

// Hoisted, never built inside a reader: a schema constructed per parse cost 2275 ns against 156 ns
// for the same shape hoisted (#21311).
//
// Loose where the host contract is strict, and required only where this client reads. The host's
// own schemas describe what it produces and stay `.strict()`; a phone that rejected an unknown
// member would turn a later optional field into a released-client break instead of the Rule 1
// addition `docs/reference/remote-wire-compatibility.md` allows.

/** Base64 of one chunk, bounded by the same arithmetic as `skill-upload-session-contract.ts`, so a
 *  host that overshoots is refused at the boundary instead of at reassembly. */
const MAX_DATA_BASE64_LENGTH = Math.ceil(MOBILE_WEB_BUNDLE_CHUNK_BYTES / 3) * 4 + 8

/** A screen the desktop asks this shell to render from the bundle. Optional, because a desktop
 *  older than the field sends none and every route then stays native, which is where they all
 *  start. Loose for the same reason the manifest is: a grant name this build does not know is not a
 *  reason to refuse a bundle, it is a reason to leave that one route native.
 *
 *  `optionalGrants` is read so this build can honour it, and typed here only — the host's own
 *  schema is where its grammar and the ceiling over the union live. A shell without this line still
 *  receives the key, because loose passes unknown members through rather than stripping them; what
 *  such a shell lacks is a policy that reads it, so it serves the route on `grants` alone. The
 *  member that must not travel on from here is the whole entry: `BridgePageRouteGrantsSchema` is
 *  `.strict()`, so `routeViewOf` builds the pairs it publishes rather than forwarding these. */
const pageRouteSchema = z.looseObject({
  pathname: z.string().min(1).max(255),
  grants: z.array(z.string().min(1).max(64)).max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS),
  optionalGrants: z
    .array(z.string().min(1).max(64))
    .max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
    .optional()
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
  // Cheapest first, and the first issue returns: the build id below is the only check here that
  // hashes, and a manifest already over the allocation ceiling must not be hashed to be refused.
  .superRefine((manifest, context) => {
    // The allocation bound, and the reason it is the sum rather than `totalBytes`: the fetch
    // allocates one buffer per asset from `byteLength` and holds them all, so a manifest declaring
    // `totalBytes` 0 alongside 256 assets of 10 MiB each would pass every ceiling above and still
    // cost 2560 MiB. The host pins sum === totalBytes; this client never trusts `totalBytes` for
    // anything, so it bounds what it will actually allocate instead.
    if (
      manifest.assets.reduce((sum, asset) => sum + asset.byteLength, 0) >
      MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        path: ['assets'],
        message: 'assets sum to more than the contract total'
      })
      return
    }
    // The same rule the host writes the manifest under, read back here rather than trusted. The id
    // is a cache key and a claim about content at once: the shell treats an id it already holds as
    // the same bytes and opens the generation on disk without paging a byte, so a stale or forged
    // id would put a bundle on screen under another one's manifest. `computeMobileWebBundleId` is
    // pure JS for exactly this reader — Metro ships no `node:crypto`.
    if (manifest.buildId !== computeMobileWebBundleId(manifest.assets)) {
      context.addIssue({
        code: 'custom',
        path: ['buildId'],
        message: 'buildId must be the content hash of the asset list'
      })
    }
  })

/** `chunkBytes` is read, never assumed: the host may shrink it without a client release. Capped at
 *  the constant because a larger value would overshoot `dataBase64` above. */
export const MobileWebBundleManifestReplySchema = z.looseObject({
  manifest: MobileWebBundleManifestReadSchema,
  chunkBytes: z.number().int().positive().max(MOBILE_WEB_BUNDLE_CHUNK_BYTES),
  /** The range grid, named only by a host that serves `mobileWeb.bundle.range`. A value this build
   *  cannot page within its `dataBase64` bound reads as absent, which keeps the fetch on chunks
   *  rather than refusing the manifest. */
  rangeBytes: z
    .number()
    .int()
    .positive()
    .max(MOBILE_WEB_BUNDLE_RANGE_BYTES)
    .optional()
    .catch(undefined)
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

/** A chunk's self-description plus the encoding of `dataBase64`. `encoding` is read as a string, not
 *  a closed enum: an encoding this build cannot decode is a typed refusal at the decoder, which
 *  names it, rather than a reply-shape failure that names nothing. */
export const MobileWebBundleRangeReplySchema = z.looseObject({
  buildId: z.string().regex(SHA256_PATTERN),
  path: MobileWebBundleAssetPathSchema,
  offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  assetByteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
  encoding: z.string().min(1).max(32),
  dataBase64: z.string().max(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH),
  eof: z.boolean()
})

export type MobileWebBundleManifestReply = z.output<typeof MobileWebBundleManifestReplySchema>
export type MobileWebBundleManifestRead = MobileWebBundleManifestReply['manifest']
export type MobileWebBundleAssetRead = MobileWebBundleManifestRead['assets'][number]
