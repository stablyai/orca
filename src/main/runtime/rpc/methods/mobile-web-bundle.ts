/**
 * Serves this install's mobile web bundle to the paired client over the already-authenticated RPC
 * connection: one call for the manifest, then one call per 48 KiB chunk of each asset, or one per
 * gzipped 384 KiB range for a client that read `rangeBytes` off the manifest reply.
 *
 * No SSH or relay proxying, ever. The bundle is an artifact of the desktop the phone paired with,
 * not something a remote execution host owns, so a runtime answers only out of its own install and
 * never forwards these methods to another host.
 *
 * `asContractError` is a total catch over the verify-and-read block: every host-side failure in
 * there, whatever its cause, reaches the client as `mobile_web_bundle_asset_changed`.
 */
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleChunkParamsSchema,
  MobileWebBundleRangeParamsSchema,
  type MobileWebBundleChunkParams,
  type MobileWebBundleChunkResult,
  type MobileWebBundleErrorCode,
  type MobileWebBundleManifestResult,
  type MobileWebBundleRangeResult
} from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import type { MobileWebBundleAsset } from '../../../../shared/mobile-web-bundle/manifest-contract'
import {
  loadBundledMobileWebBundle,
  type BundledMobileWebBundle
} from '../../bundled-mobile-web-bundle'
import { isClientDisconnectedError } from '../../orca-runtime-core'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import {
  readMobileWebBundleAssetWindow,
  verifyMobileWebBundleAsset
} from './mobile-web-bundle-asset-reader'
import {
  acquireMobileWebBundleReadSlot,
  mobileWebBundleReadBucket
} from './mobile-web-bundle-read-admission'
import { encodeMobileWebBundleRange } from './mobile-web-bundle-range-encoding'

/** The code IS the message: `InvalidArgumentError` carries no data field, so the message is the only
 *  place a stable code can travel, and a client must be able to branch without matching prose. */
function bundleError(code: MobileWebBundleErrorCode): InvalidArgumentError {
  return new InvalidArgumentError(code)
}

function requireBundle(): BundledMobileWebBundle {
  const bundle = loadBundledMobileWebBundle()
  if (!bundle) {
    throw bundleError('mobile_web_bundle_unavailable')
  }
  return bundle
}

function abortIfDisconnected(ctx: RpcContext): void {
  if (ctx.signal?.aborted) {
    throw new Error('client_disconnected')
  }
}

/** Every other way a read can fail — the asset unlinked, unreadable, or shorter than the manifest
 *  promised — is one thing to a client: this bundle no longer matches the manifest it was handed.
 *  The host path stays on the host; the reply carries only the code. */
function asContractError(error: unknown, path: string): unknown {
  if (error instanceof InvalidArgumentError || isClientDisconnectedError(error)) {
    return error
  }
  console.warn(`[mobile-web-bundle] read failed for ${path}:`, error)
  return bundleError('mobile_web_bundle_asset_changed')
}

/** Exact match against a manifest member. `path` is never joined, normalised, or prefix-matched, so
 *  traversal is not mitigated here — it is unreachable. */
function findAsset(bundle: BundledMobileWebBundle, path: string): MobileWebBundleAsset {
  const asset = bundle.manifest.assets.find((candidate) => candidate.path === path)
  if (!asset) {
    throw bundleError('mobile_web_bundle_asset_unknown')
  }
  return asset
}

/** Alignment is against the grid the manifest reply advertised for the method: `chunkBytes` or
 *  `rangeBytes`, which the contract leaves off `offset` so the host can shrink either without a
 *  client release. Offset 0 is always in range, so a zero-byte asset is still fetchable and still
 *  reports eof. */
function assertOffsetAddressesAWindow(
  offset: number,
  windowBytes: number,
  asset: MobileWebBundleAsset
): void {
  if (offset % windowBytes !== 0) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
  if (offset > 0 && offset >= asset.byteLength) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
}

/** The self-description every chunk or range reply carries, plus the raw bytes of its window. */
type VerifiedWindow = {
  header: Omit<MobileWebBundleChunkResult, 'dataBase64'>
  data: Buffer
}

/** The checks and the read both methods share, in order: build, member, alignment, read slot,
 *  whole-asset verdict, then the window. `encode` runs inside the slot so a deflate is charged too. */
async function readVerifiedWindow<T>(
  ctx: RpcContext,
  params: MobileWebBundleChunkParams,
  windowBytes: number,
  encode: (window: VerifiedWindow) => Promise<T>
): Promise<T> {
  const bundle = requireBundle()
  // Checked before the asset lookup: a desktop that auto-updated mid-download must tell the
  // client to restart from the manifest, not that its path went missing.
  if (params.buildId !== bundle.manifest.buildId) {
    throw bundleError('mobile_web_bundle_build_changed')
  }
  const asset = findAsset(bundle, params.path)
  assertOffsetAddressesAWindow(params.offset, windowBytes, asset)

  const release = acquireMobileWebBundleReadSlot(mobileWebBundleReadBucket(ctx))
  if (!release) {
    throw bundleError('mobile_web_bundle_read_limited')
  }
  try {
    abortIfDisconnected(ctx)
    if (!(await verifyMobileWebBundleAsset(bundle.root, bundle.manifest.buildId, asset))) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    abortIfDisconnected(ctx)
    const data = await readMobileWebBundleAssetWindow(
      bundle.root,
      asset,
      params.offset,
      windowBytes
    )
    abortIfDisconnected(ctx)
    return await encode({
      header: {
        buildId: bundle.manifest.buildId,
        path: asset.path,
        offset: params.offset,
        // The whole asset's length and hash, so one window describes the asset it belongs to.
        assetByteLength: asset.byteLength,
        sha256: asset.sha256,
        eof: params.offset + data.byteLength >= asset.byteLength
      },
      data
    })
  } catch (error) {
    throw asContractError(error, asset.path)
  } finally {
    release()
  }
}

export const MOBILE_WEB_BUNDLE_METHODS = [
  defineMethod({
    name: MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
    params: null,
    handler: async (): Promise<MobileWebBundleManifestResult> => ({
      manifest: requireBundle().manifest,
      chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES,
      rangeBytes: MOBILE_WEB_BUNDLE_RANGE_BYTES
    })
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_CHUNK_METHOD,
    params: MobileWebBundleChunkParamsSchema,
    handler: (params, ctx): Promise<MobileWebBundleChunkResult> =>
      readVerifiedWindow(ctx, params, MOBILE_WEB_BUNDLE_CHUNK_BYTES, async (window) => ({
        ...window.header,
        dataBase64: window.data.toString('base64')
      }))
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_RANGE_METHOD,
    params: MobileWebBundleRangeParamsSchema,
    handler: (params, ctx): Promise<MobileWebBundleRangeResult> =>
      readVerifiedWindow(ctx, params, MOBILE_WEB_BUNDLE_RANGE_BYTES, async (window) => {
        const encoded = await encodeMobileWebBundleRange(window.data)
        return {
          ...window.header,
          encoding: encoded.encoding,
          dataBase64: encoded.bytes.toString('base64')
        }
      })
  })
]
