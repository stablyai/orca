/**
 * Serves this install's mobile web bundle to the paired client over the already-authenticated RPC
 * connection: one call for the manifest, then one call per 48 KiB chunk of each asset.
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
  MobileWebBundleChunkParamsSchema,
  type MobileWebBundleChunkResult,
  type MobileWebBundleErrorCode,
  type MobileWebBundleManifestResult
} from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import type { MobileWebBundleAsset } from '../../../../shared/mobile-web-bundle/manifest-contract'
import {
  loadBundledMobileWebBundle,
  type BundledMobileWebBundle
} from '../../bundled-mobile-web-bundle'
import { isClientDisconnectedError } from '../../orca-runtime-core'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import {
  readMobileWebBundleAssetChunk,
  verifyMobileWebBundleAsset
} from './mobile-web-bundle-asset-reader'
import {
  acquireMobileWebBundleReadSlot,
  mobileWebBundleReadBucket
} from './mobile-web-bundle-read-admission'

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

/** Alignment is against the size the manifest reply advertised, which the contract deliberately
 *  leaves off `offset` so the host can shrink the chunk without a client release. Offset 0 is always
 *  in range, so a zero-byte asset is still fetchable and still reports eof. */
function assertOffsetAddressesAChunk(offset: number, asset: MobileWebBundleAsset): void {
  if (offset % MOBILE_WEB_BUNDLE_CHUNK_BYTES !== 0) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
  if (offset > 0 && offset >= asset.byteLength) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
}

export const MOBILE_WEB_BUNDLE_METHODS = [
  defineMethod({
    name: MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
    params: null,
    handler: async (): Promise<MobileWebBundleManifestResult> => ({
      manifest: requireBundle().manifest,
      chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES
    })
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_CHUNK_METHOD,
    params: MobileWebBundleChunkParamsSchema,
    handler: async (params, ctx): Promise<MobileWebBundleChunkResult> => {
      const bundle = requireBundle()
      // Checked before the asset lookup: a desktop that auto-updated mid-download must tell the
      // client to restart from the manifest, not that its path went missing.
      if (params.buildId !== bundle.manifest.buildId) {
        throw bundleError('mobile_web_bundle_build_changed')
      }
      const asset = findAsset(bundle, params.path)
      assertOffsetAddressesAChunk(params.offset, asset)

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
        const data = await readMobileWebBundleAssetChunk(
          bundle.root,
          asset,
          params.offset,
          MOBILE_WEB_BUNDLE_CHUNK_BYTES
        )
        return {
          buildId: bundle.manifest.buildId,
          path: asset.path,
          offset: params.offset,
          // The whole asset's length and hash, so one chunk describes the asset it belongs to.
          assetByteLength: asset.byteLength,
          sha256: asset.sha256,
          dataBase64: data.toString('base64'),
          eof: params.offset + data.byteLength >= asset.byteLength
        }
      } catch (error) {
        throw asContractError(error, asset.path)
      } finally {
        release()
      }
    }
  })
]
