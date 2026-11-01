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

// Hoist reusable readers and accept added host fields; strict writer contracts must not become released-client compatibility gates.

// Bound base64 at the read boundary before oversized data reaches reassembly.
const MAX_DATA_BASE64_LENGTH = Math.ceil(MOBILE_WEB_BUNDLE_CHUNK_BYTES / 3) * 4 + 8

// Read added route/grant fields loosely; unknown grants affect that route rather than refusing the whole bundle.
// Build explicit published route pairs because BridgePageRouteGrantsSchema is strict.
const pageRouteSchema = z.looseObject({
  pathname: z.string().min(1).max(255),
  grants: z.array(z.string().min(1).max(64)).max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS),
  optionalGrants: z
    .array(z.string().min(1).max(64))
    .max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
    .optional(),
  // A value this build cannot read is no declaration, never a refused bundle.
  canOwnHostArea: z.boolean().optional().catch(undefined),
  canOwnHostAreaAcrossLayouts: z.boolean().optional().catch(undefined)
})

const assetSchema = z.looseObject({
  path: MobileWebBundleAssetPathSchema,
  sha256: z.string().regex(SHA256_PATTERN),
  byteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  contentType: z.string().min(1)
})

// Read unknown schema versions as numbers so compatibility can name the required update.
// Reuse this loose reader for cached manifests too; strict reloads would redownload on every added host field.
export const MobileWebBundleManifestReadSchema = z
  .looseObject({
    schemaVersion: z.number().int(),
    buildId: z.string().regex(SHA256_PATTERN),
    minCompatibleRuntimeProtocolVersion: z.number().int().nonnegative(),
    runtimeProtocolVersion: z.number().int().nonnegative(),
    pageVersion: z.number().int().nonnegative().optional(),
    entrypoint: MobileWebBundleAssetPathSchema,
    totalBytes: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES),
    assets: z.array(assetSchema).min(1).max(MOBILE_WEB_BUNDLE_MAX_ASSETS),
    routes: z.array(pageRouteSchema).max(MOBILE_WEB_BUNDLE_MAX_ROUTES).optional()
  })
  // Check allocation limits before content-id hashing to avoid hashing a manifest already known to be oversized.
  .superRefine((manifest, context) => {
    // Bound the sum of asset lengths, which drives buffer allocation; declared totalBytes is untrusted.
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
    // Recompute the pure-JS content id before trusting a cached generation; Metro has no node:crypto.
    if (manifest.buildId !== computeMobileWebBundleId(manifest.assets)) {
      context.addIssue({
        code: 'custom',
        path: ['buildId'],
        message: 'buildId must be the content hash of the asset list'
      })
    }
  })

// Honor host-declared smaller chunks while capping them to the base64 boundary.
export const MobileWebBundleManifestReplySchema = z.looseObject({
  manifest: MobileWebBundleManifestReadSchema,
  chunkBytes: z.number().int().positive().max(MOBILE_WEB_BUNDLE_CHUNK_BYTES),
  // Treat unusable range grids as absent to preserve chunk fallback with older/newer hosts.
  rangeBytes: z
    .number()
    .int()
    .positive()
    .max(MOBILE_WEB_BUNDLE_RANGE_BYTES)
    .optional()
    .catch(undefined)
})

// Echo route/offset plus whole-asset identity so reassembly needs no second index and cannot misplace replies.
const windowHeaderFields = {
  buildId: z.string().regex(SHA256_PATTERN),
  path: MobileWebBundleAssetPathSchema,
  offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  assetByteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
  eof: z.boolean()
}

export const MobileWebBundleChunkReplySchema = z.looseObject({
  ...windowHeaderFields,
  dataBase64: z.string().max(MAX_DATA_BASE64_LENGTH)
})

// Read encoding as a string so the decoder can report an unknown encoding instead of an opaque shape error.
export const MobileWebBundleRangeReplySchema = z.looseObject({
  ...windowHeaderFields,
  encoding: z.string().min(1).max(32),
  dataBase64: z.string().max(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH)
})

export type MobileWebBundleManifestReply = z.output<typeof MobileWebBundleManifestReplySchema>
export type MobileWebBundleManifestRead = MobileWebBundleManifestReply['manifest']
export type MobileWebBundleAssetRead = MobileWebBundleManifestRead['assets'][number]
