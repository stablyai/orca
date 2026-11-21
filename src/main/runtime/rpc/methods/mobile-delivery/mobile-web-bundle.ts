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
  type MobileWebBundleAsset,
  type MobileWebBundleCatalog
} from '../../../../../shared/mobile-web-bundle/manifest-contract'
import {
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_REPLY_BYTES,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD,
  MobileWebBundleLocaleCatalogParamsSchema,
  MobileWebBundleLocaleCatalogRangeParamsSchema,
  type MobileWebBundleLocaleCatalogParams,
  type MobileWebBundleLocaleCatalogRangeParams,
  type MobileWebBundleLocaleCatalogRangeResult,
  type MobileWebBundleLocaleCatalogResult
} from '../../../../../shared/mobile-web-bundle/locale-catalog-contract'
import {
  loadBundledMobileWebBundle,
  type BundledMobileWebBundle
} from './bundled-mobile-web-bundle'
import { isClientDisconnectedError } from '../../../client/runtime-client-disconnect'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../../core'
import {
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

function findCatalog(bundle: BundledMobileWebBundle, locale: string): MobileWebBundleCatalog {
  const entry = bundle.manifest.catalogs?.find((catalog) => catalog.locale === locale)
  if (!entry) {
    throw bundleError('mobile_web_bundle_asset_unknown')
  }
  return entry
}

// Its own budget, so a page's catalog reads never wait behind its shell's bundle download.
function catalogReadBucket(ctx: RpcContext): string {
  return `catalog:${mobileWebBundleReadBucket(ctx)}`
}

/** Answer from the build's own catalog file, so the page reads the strings it was built with. */
async function readLocaleCatalog(
  params: MobileWebBundleLocaleCatalogParams,
  ctx: RpcContext
): Promise<MobileWebBundleLocaleCatalogResult> {
  const bundle = await requireBundle()
  const entry = findCatalog(bundle, params.locale)
  if (params.knownSha256 === entry.sha256) {
    return { locale: entry.locale, sha256: entry.sha256, catalog: null }
  }
  // Pages that predate ranges read this as no catalog; sent whole, it would overflow the relay frame.
  if (entry.byteLength > MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_REPLY_BYTES) {
    throw bundleError('mobile_web_bundle_asset_unknown')
  }
  const release = acquireMobileWebBundleReadSlot(catalogReadBucket(ctx))
  if (!release) {
    throw bundleError('mobile_web_bundle_read_limited')
  }
  try {
    abortIfDisconnected(ctx)
    const bytes = await readFile(join(bundle.root, entry.path))
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    const catalog: unknown = JSON.parse(bytes.toString('utf8'))
    if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    return { locale: entry.locale, sha256: entry.sha256, catalog: { ...catalog } }
  } catch (error) {
    throw asContractError(error, entry.path)
  } finally {
    release()
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

/** One admitted read: `source`'s window at `offset`, cut once `verified`'s whole file matches its hash. */
type AdmittedRead = {
  readonly bucket: string
  readonly bundle: BundledMobileWebBundle
  readonly verified: Pick<MobileWebBundleAsset, 'path' | 'sha256'>
  readonly source: WindowSource
  readonly offset: number
  readonly windowBytes: number
}

/** Check alignment, read slot, the file's hash, then the window; keep encoding inside the slot to charge deflate work. */
async function readAdmittedWindow<T>(
  ctx: RpcContext,
  read: AdmittedRead,
  encode: (data: Buffer) => Promise<T>
): Promise<T> {
  const { bundle, verified, source, offset, windowBytes } = read
  assertOffsetAddressesAWindow(offset, windowBytes, source)
  const release = acquireMobileWebBundleReadSlot(read.bucket)
  if (!release) {
    throw bundleError('mobile_web_bundle_read_limited')
  }
  try {
    abortIfDisconnected(ctx)
    if (!(await verifyMobileWebBundleAsset(bundle.root, bundle.manifest.buildId, verified))) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    abortIfDisconnected(ctx)
    const data = await readMobileWebBundleAssetWindow(bundle.root, source, offset, windowBytes)
    abortIfDisconnected(ctx)
    return await encode(data)
  } catch (error) {
    throw asContractError(error, verified.path)
  } finally {
    release()
  }
}

/** Check build and member before the admitted read. */
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
  const bucket = mobileWebBundleReadBucket(ctx)
  const read = { bucket, bundle, verified: asset, source, offset: params.offset, windowBytes }
  return readAdmittedWindow(ctx, read, (data) =>
    encode({
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
  )
}

/** A window of the catalog's file; the page hashes what it reassembles against the `sha256` every window restates. */
async function readLocaleCatalogRange(
  params: MobileWebBundleLocaleCatalogRangeParams,
  ctx: RpcContext
): Promise<MobileWebBundleLocaleCatalogRangeResult> {
  const bundle = await requireBundle()
  const entry = findCatalog(bundle, params.locale)
  const { locale, sha256, byteLength } = entry
  const header = { locale, sha256, byteLength, offset: params.offset }
  if (params.knownSha256 === sha256) {
    return { ...header, eof: true, encoding: 'identity', dataBase64: null }
  }
  const read = {
    bucket: catalogReadBucket(ctx),
    bundle,
    verified: entry,
    source: entry,
    offset: params.offset,
    windowBytes: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES
  }
  return readAdmittedWindow(ctx, read, async (data) => {
    const encoded = await encodeMobileWebBundleRange(data)
    return {
      ...header,
      eof: params.offset + data.byteLength >= byteLength,
      encoding: encoded.encoding,
      dataBase64: encoded.bytes.toString('base64')
    }
  })
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
    handler: async (): Promise<MobileWebBundleManifestResult> => ({
      manifest: (await requireBundle()).manifest,
      chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES,
      // Complete replies must arrive within the phone's stall budget even on slow relays.
      rangeBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES
    })
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
    handler: readLocaleCatalog
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD,
    permission: 'workspace',
    params: MobileWebBundleLocaleCatalogRangeParamsSchema,
    handler: readLocaleCatalogRange
  })
]
