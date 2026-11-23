/** Serve only this install's bundle over authenticated RPC: manifest, then chunks or advertised ranges, and the page's language catalog.
 * Never proxy to SSH/relay execution hosts: the phone paired with this desktop.
 * Verify/read failures map to asset-changed without exposing host paths. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MOBILE_WEB_BUNDLE_BROTLI_RANGE_METHOD,
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleChunkParamsSchema,
  MobileWebBundleRangeParamsSchema,
  type MobileWebBundleBrotliRangeResult,
  type MobileWebBundleChunkParams,
  type MobileWebBundleChunkResult,
  type MobileWebBundleErrorCode,
  type MobileWebBundleManifestResult,
  type MobileWebBundleRangeResult
} from '../../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import {
  mobileWebBundleBrotliPath,
  type MobileWebBundleAsset
} from '../../../../../shared/mobile-web-bundle/manifest-contract'
import {
  MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  MobileWebBundleLocaleCatalogParamsSchema,
  type MobileWebBundleGzipCatalogResult,
  type MobileWebBundleLocaleCatalogParams,
  type MobileWebBundleLocaleCatalogResult
} from '../../../../../shared/mobile-web-bundle/locale-catalog-contract'
import {
  MOBILE_WEB_CATALOG_MAX_RESULT_BYTES,
  gzipCatalogResult,
  identityCatalogResult
} from '../../../../../shared/mobile-web-bundle/catalog-reply-size'
import {
  loadBundledMobileWebBundle,
  parseInstalledCatalogGzip,
  type BundledMobileWebBundle
} from './bundled-mobile-web-bundle'
import { isClientDisconnectedError } from '../../../client/runtime-client-disconnect'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../../core'
import {
  readExactMobileWebCatalogFile,
  readMobileWebBundleAssetWindow,
  verifyMobileWebBundleAsset
} from './mobile-web-bundle-asset-reader'
import {
  acquireMobileWebBundleReadSlot,
  mobileWebBundleReadBucket
} from './mobile-web-bundle-read-admission'
import { encodeMobileWebBundleRange } from './mobile-web-bundle-range-encoding'

/** Use the code as message: InvalidArgumentError has no data, and clients must branch without matching prose. */
function bundleError(code: MobileWebBundleErrorCode): InvalidArgumentError {
  return new InvalidArgumentError(code)
}

async function requireBundle(): Promise<BundledMobileWebBundle> {
  const bundle = await loadBundledMobileWebBundle()
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

/** Answer from the build's own catalog file, so the page reads the strings it was built with. */
async function readLocaleCatalog(
  params: MobileWebBundleLocaleCatalogParams,
  ctx: RpcContext
): Promise<MobileWebBundleLocaleCatalogResult>
async function readLocaleCatalog(
  params: MobileWebBundleLocaleCatalogParams,
  ctx: RpcContext,
  encoded: true
): Promise<MobileWebBundleLocaleCatalogResult | MobileWebBundleGzipCatalogResult>
async function readLocaleCatalog(
  params: MobileWebBundleLocaleCatalogParams,
  ctx: RpcContext,
  encoded = false
): Promise<MobileWebBundleLocaleCatalogResult | MobileWebBundleGzipCatalogResult> {
  const bundle = await requireBundle()
  const entry = bundle.manifest.catalogs?.find((catalog) => catalog.locale === params.locale)
  if (!entry) {
    throw bundleError('mobile_web_bundle_asset_unknown')
  }
  const gzip = encoded && entry.gzip !== undefined ? parseInstalledCatalogGzip(entry) : undefined
  if (gzip === null) {
    throw bundleError('mobile_web_bundle_asset_changed')
  }
  if (params.knownSha256 === entry.sha256) {
    return identityCatalogResult(entry, null)
  }
  if (encoded && (gzip ?? entry).byteLength > MOBILE_WEB_CATALOG_MAX_RESULT_BYTES) {
    throw bundleError('mobile_web_bundle_asset_changed')
  }
  // Its own budget, so a page's one catalog read never waits behind its shell's bundle download.
  const release = acquireMobileWebBundleReadSlot(`catalog:${mobileWebBundleReadBucket(ctx)}`)
  if (!release) {
    throw bundleError('mobile_web_bundle_read_limited')
  }
  try {
    abortIfDisconnected(ctx)
    const bytes = encoded
      ? await readExactMobileWebCatalogFile(bundle.root, gzip ?? entry, () =>
          abortIfDisconnected(ctx)
        )
      : await readFile(join(bundle.root, entry.path))
    if (encoded) {
      abortIfDisconnected(ctx)
    }
    if (!encoded && createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    if (gzip) {
      const metadata = gzipCatalogResult(entry, gzip, '')
      if (
        Buffer.byteLength(JSON.stringify(metadata)) + Math.ceil(bytes.length / 3) * 4 >
        MOBILE_WEB_CATALOG_MAX_RESULT_BYTES
      ) {
        throw bundleError('mobile_web_bundle_asset_changed')
      }
      return { ...metadata, dataBase64: bytes.toString('base64') }
    }
    const text = encoded
      ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      : bytes.toString('utf8')
    const catalog: unknown = JSON.parse(text)
    if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    const result = identityCatalogResult(entry, { ...catalog })
    if (
      encoded &&
      Buffer.byteLength(JSON.stringify(result)) > MOBILE_WEB_CATALOG_MAX_RESULT_BYTES
    ) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    return result
  } catch (error) {
    throw asContractError(error, (gzip ?? entry).path)
  } finally {
    release()
  }
}

async function readBundleManifest(): Promise<MobileWebBundleManifestResult> {
  const { catalogs, ...manifest } = (await requireBundle()).manifest
  return {
    // Catalog sidecars are host-only; their validity is checked when the encoded method selects one.
    manifest: {
      ...manifest,
      ...(catalogs && {
        catalogs: catalogs.map(({ locale, path, sha256, byteLength }) => ({
          locale,
          path,
          sha256,
          byteLength
        }))
      })
    },
    chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES,
    rangeBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES
  }
}

/** Map unreadable, missing or truncated assets to asset-changed; host paths stay private. */
function asContractError(error: unknown, path: string): unknown {
  if (error instanceof InvalidArgumentError || isClientDisconnectedError(error)) {
    return error
  }
  console.warn(`[mobile-web-bundle] read failed for ${path}:`, error)
  return bundleError('mobile_web_bundle_asset_changed')
}

/** Match exact manifest members only; never normalize, join or prefix-match client paths. */
function findAsset(bundle: BundledMobileWebBundle, path: string): MobileWebBundleAsset {
  const asset = bundle.manifest.assets.find((candidate) => candidate.path === path)
  if (!asset) {
    throw bundleError('mobile_web_bundle_asset_unknown')
  }
  return asset
}

/** Align against the manifest-advertised grid so hosts can shrink windows without a client release; offset zero also fetches empty assets. */
function assertOffsetAddressesAWindow(
  offset: number,
  windowBytes: number,
  file: WindowSource
): void {
  if (offset % windowBytes !== 0) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
  if (offset > 0 && offset >= file.byteLength) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
}

/** The file a window is cut from: the asset itself, or its brotli copy. */
type WindowSource = Pick<MobileWebBundleAsset, 'path' | 'byteLength'>

/** Only assets the manifest gives a copy have one; asking for another is asking for an unlisted file. */
function brotliCopyOf(asset: MobileWebBundleAsset): WindowSource {
  if (asset.brotliByteLength === undefined) {
    throw bundleError('mobile_web_bundle_asset_unknown')
  }
  return { path: mobileWebBundleBrotliPath(asset.path), byteLength: asset.brotliByteLength }
}

/** The self-description every chunk or range reply carries, plus the raw bytes of its window. */
type VerifiedWindow = {
  header: Omit<MobileWebBundleChunkResult, 'dataBase64'>
  data: Buffer
}

/** Check build, member, alignment, read slot, asset hash, then window; keep encoding inside the slot to charge deflate work. */
async function readVerifiedWindow<T>(
  ctx: RpcContext,
  params: MobileWebBundleChunkParams,
  windowBytes: number,
  encode: (window: VerifiedWindow) => Promise<T>,
  sourceOf: (asset: MobileWebBundleAsset) => WindowSource = (asset) => asset
): Promise<T> {
  const bundle = await requireBundle()
  // Check build before path: auto-update means restart from the manifest, not missing-asset.
  if (params.buildId !== bundle.manifest.buildId) {
    throw bundleError('mobile_web_bundle_build_changed')
  }
  const asset = findAsset(bundle, params.path)
  const source = sourceOf(asset)
  assertOffsetAddressesAWindow(params.offset, windowBytes, source)

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
      source,
      params.offset,
      windowBytes
    )
    abortIfDisconnected(ctx)
    return await encode({
      header: {
        buildId: bundle.manifest.buildId,
        path: asset.path,
        offset: params.offset,
        assetByteLength: asset.byteLength,
        sha256: asset.sha256,
        eof: params.offset + data.byteLength >= source.byteLength
      },
      data
    })
  } catch (error) {
    throw asContractError(error, asset.path)
  } finally {
    release()
  }
}

/** Chunks and brotli windows go out as read: chunks predate encodings, and brotli output does not shrink again. */
async function rawWindowReply(window: VerifiedWindow): Promise<MobileWebBundleChunkResult> {
  return { ...window.header, dataBase64: window.data.toString('base64') }
}

export const MOBILE_WEB_BUNDLE_METHODS = [
  defineMethod({
    name: MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
    permission: 'workspace',
    params: null,
    handler: readBundleManifest
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_CHUNK_METHOD,
    permission: 'workspace',
    params: MobileWebBundleChunkParamsSchema,
    handler: (params, ctx): Promise<MobileWebBundleChunkResult> =>
      readVerifiedWindow(ctx, params, MOBILE_WEB_BUNDLE_CHUNK_BYTES, rawWindowReply)
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_RANGE_METHOD,
    permission: 'workspace',
    params: MobileWebBundleRangeParamsSchema,
    handler: (params, ctx): Promise<MobileWebBundleRangeResult> =>
      readVerifiedWindow(ctx, params, MOBILE_WEB_BUNDLE_CHUNK_BYTES, async (window) => {
        const encoded = await encodeMobileWebBundleRange(window.data)
        return {
          ...window.header,
          encoding: encoded.encoding,
          dataBase64: encoded.bytes.toString('base64')
        }
      })
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_BROTLI_RANGE_METHOD,
    permission: 'workspace',
    params: MobileWebBundleRangeParamsSchema,
    handler: (params, ctx): Promise<MobileWebBundleBrotliRangeResult> =>
      // The raw asset's hash still gates every window of its copy.
      readVerifiedWindow(ctx, params, MOBILE_WEB_BUNDLE_CHUNK_BYTES, rawWindowReply, brotliCopyOf)
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
    permission: 'workspace',
    params: MobileWebBundleLocaleCatalogParamsSchema,
    handler: (params, ctx) => readLocaleCatalog(params, ctx)
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD,
    permission: 'workspace',
    params: MobileWebBundleLocaleCatalogParamsSchema,
    handler: (params, ctx) => readLocaleCatalog(params, ctx, true)
  })
]
