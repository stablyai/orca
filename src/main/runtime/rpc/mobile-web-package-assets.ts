import { stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  MOBILE_WEB_PACKAGE_MAX_IN_FLIGHT_BYTES,
  MobileWebPackageAssetChunkSchema,
  MobileWebPackageGzipAssetChunkSchema,
  MobileWebPackageManifestResponseSchema,
  type MobileWebPackageAssetChunk,
  type MobileWebPackageGzipAssetChunk,
  type MobileWebPackageAssetParams,
  type MobileWebPackageManifestResponse
} from '../../../shared/mobile-web/package-rpc-contract'
import {
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  type MobileWebAsset
} from '../../../shared/mobile-web/manifest-contract'
import { resolveMobileWebPackageRoot } from './mobile-web-package-root'
import {
  assertManifestFingerprint,
  readAssetRange,
  readManifestBytes,
  resolveDeclaredAssetPath,
  sha256,
  throwIfAborted,
  verifyPackage,
  type VerifiedMobileWebPackage
} from './mobile-web-package-verification'

type PackageReadState = { count: number; bytes: number }
type AssetRangeReader = (path: string, offset: number, length: number) => Promise<Buffer>

type MobileWebPackageAssetsOptions = {
  resolveRoot?: () => string
  readAssetRange?: AssetRangeReader
  gzipCacheMaxBytes?: number
}

// Why: `length` is client-chosen, so one source byte can be cached under eight keys and
// the fingerprint that clears the map never changes on a shipped desktop. Bound the
// retained total instead, evicting least-recently-used first.
const GZIP_CACHE_MAX_BYTES = 16 * 1024 * 1024

export class MobileWebPackageAssets {
  private readonly resolveRoot: () => string
  private readonly readAssetRange: AssetRangeReader
  private cached: { fingerprint: string; package: VerifiedMobileWebPackage } | null = null
  private verifying: {
    root: string
    fingerprint: string
    promise: Promise<VerifiedMobileWebPackage>
  } | null = null
  private readonly readStates = new Map<string, PackageReadState>()
  private readonly gzipChunks = new Map<string, Buffer>()
  private gzipChunkBytes = 0
  private readonly gzipCacheMaxBytes: number

  constructor(options: MobileWebPackageAssetsOptions = {}) {
    this.resolveRoot = options.resolveRoot ?? resolveMobileWebPackageRoot
    this.readAssetRange = options.readAssetRange ?? readAssetRange
    this.gzipCacheMaxBytes = options.gzipCacheMaxBytes ?? GZIP_CACHE_MAX_BYTES
  }

  async getManifest(): Promise<MobileWebPackageManifestResponse> {
    const verified = await this.getVerifiedPackage()
    return MobileWebPackageManifestResponseSchema.parse({
      manifest: verified.manifest,
      chunkBytes: MOBILE_WEB_PACKAGE_CHUNK_BYTES
    })
  }

  async getAssetChunk(
    params: MobileWebPackageAssetParams,
    options: { connectionId?: string; signal?: AbortSignal } = {}
  ): Promise<MobileWebPackageAssetChunk> {
    // Ranged reads exist only on the gzip method; the raw chunk schema caps at one chunk.
    if (params.length !== undefined && params.length !== MOBILE_WEB_PACKAGE_CHUNK_BYTES) {
      throw new Error('mobile_web_package_offset_invalid')
    }
    const read = await this.readVerifiedRange(params, options, MOBILE_WEB_PACKAGE_CHUNK_BYTES)
    return MobileWebPackageAssetChunkSchema.parse({
      buildId: read.buildId,
      path: read.asset.path,
      offset: params.offset,
      byteLength: read.bytes.byteLength,
      sha256: sha256(read.bytes),
      dataBase64: read.bytes.toString('base64'),
      eof: read.eof
    })
  }

  private async readVerifiedRange(
    params: MobileWebPackageAssetParams,
    options: { connectionId?: string; signal?: AbortSignal },
    requestedLength: number
  ): Promise<{ buildId: string; asset: MobileWebAsset; bytes: Buffer; eof: boolean }> {
    throwIfAborted(options.signal)
    const verified = await this.getVerifiedPackage()
    const asset = this.validateAssetParams(verified, params)
    const byteLength = Math.min(requestedLength, asset.byteLength - params.offset)
    const release = this.acquireRead(options.connectionId ?? 'in-process', byteLength)
    try {
      const path = resolveDeclaredAssetPath(verified.root, asset.path)
      const expectedStat = verified.fileStatsByPath.get(asset.path)!
      const currentStat = await stat(path)
      if (currentStat.size !== expectedStat.size || currentStat.mtimeMs !== expectedStat.mtimeMs) {
        this.cached = null
        throw new Error('mobile_web_package_asset_changed')
      }
      const bytes = await this.readAssetRange(path, params.offset, byteLength)
      throwIfAborted(options.signal)
      if (bytes.byteLength !== byteLength) {
        throw new Error('mobile_web_package_asset_truncated')
      }
      await assertManifestFingerprint(verified.root, verified.manifestFingerprint)
      throwIfAborted(options.signal)
      return {
        buildId: verified.manifest.buildId,
        asset,
        bytes,
        eof: params.offset + byteLength === asset.byteLength
      }
    } finally {
      release()
    }
  }

  private async getVerifiedPackage(): Promise<VerifiedMobileWebPackage> {
    const root = this.resolveRoot()
    const manifestBytes = await readManifestBytes(root)
    const fingerprint = sha256(manifestBytes)
    if (this.cached?.fingerprint === fingerprint && this.cached.package.root === root) {
      return this.cached.package
    }
    if (this.verifying?.fingerprint === fingerprint && this.verifying.root === root) {
      return this.verifying.promise
    }
    const promise = verifyPackage(root, manifestBytes, fingerprint)
    this.verifying = { root, fingerprint, promise }
    try {
      const verified = await promise
      this.gzipChunks.clear()
      this.gzipChunkBytes = 0
      this.cached = { fingerprint, package: verified }
      return verified
    } finally {
      if (this.verifying?.promise === promise) {
        this.verifying = null
      }
    }
  }

  async getAssetGzipChunk(
    params: MobileWebPackageAssetParams,
    options: { connectionId?: string; signal?: AbortSignal } = {}
  ): Promise<MobileWebPackageGzipAssetChunk> {
    const requestedLength = params.length ?? MOBILE_WEB_PACKAGE_CHUNK_BYTES
    const key = `${params.buildId}:${params.path}:${params.offset}:${requestedLength}`
    const cached = this.readGzipChunk(key)
    if (cached) {
      throwIfAborted(options.signal)
      const verified = await this.getVerifiedPackage()
      const asset = this.validateAssetParams(verified, params)
      await this.assertAssetUnchanged(verified, asset)
      const sourceByteLength = Math.min(requestedLength, asset.byteLength - params.offset)
      return this.gzipResponse(
        verified.manifest.buildId,
        asset,
        params.offset,
        sourceByteLength,
        cached
      )
    }
    const read = await this.readVerifiedRange(params, options, requestedLength)
    const compressed = compressAssetRange(read.bytes)
    this.storeGzipChunk(key, compressed)
    return this.gzipResponse(
      read.buildId,
      read.asset,
      params.offset,
      read.bytes.byteLength,
      compressed
    )
  }

  /** Reading marks the entry most-recently-used; Map iteration is insertion-ordered. */
  private readGzipChunk(key: string): Buffer | undefined {
    const cached = this.gzipChunks.get(key)
    if (!cached) {
      return undefined
    }
    this.gzipChunks.delete(key)
    this.gzipChunks.set(key, cached)
    return cached
  }

  private storeGzipChunk(key: string, compressed: Buffer): void {
    if (compressed.byteLength > this.gzipCacheMaxBytes) {
      return
    }
    const previous = this.gzipChunks.get(key)
    if (previous) {
      this.gzipChunks.delete(key)
      this.gzipChunkBytes -= previous.byteLength
    }
    this.gzipChunks.set(key, compressed)
    this.gzipChunkBytes += compressed.byteLength
    for (const [oldest, bytes] of this.gzipChunks) {
      if (this.gzipChunkBytes <= this.gzipCacheMaxBytes) {
        return
      }
      this.gzipChunks.delete(oldest)
      this.gzipChunkBytes -= bytes.byteLength
    }
  }

  private gzipResponse(
    buildId: string,
    asset: MobileWebAsset,
    offset: number,
    sourceByteLength: number,
    compressed: Buffer
  ): MobileWebPackageGzipAssetChunk {
    return MobileWebPackageGzipAssetChunkSchema.parse({
      buildId,
      path: asset.path,
      offset,
      sourceByteLength,
      byteLength: compressed.byteLength,
      sha256: sha256(compressed),
      dataBase64: compressed.toString('base64'),
      eof: offset + sourceByteLength === asset.byteLength,
      encoding: 'gzip'
    })
  }

  private async assertAssetUnchanged(
    verified: VerifiedMobileWebPackage,
    asset: MobileWebAsset
  ): Promise<void> {
    const path = resolveDeclaredAssetPath(verified.root, asset.path)
    const expectedStat = verified.fileStatsByPath.get(asset.path)!
    const currentStat = await stat(path)
    if (currentStat.size !== expectedStat.size || currentStat.mtimeMs !== expectedStat.mtimeMs) {
      this.cached = null
      throw new Error('mobile_web_package_asset_changed')
    }
    await assertManifestFingerprint(verified.root, verified.manifestFingerprint)
  }

  private validateAssetParams(
    verified: VerifiedMobileWebPackage,
    params: MobileWebPackageAssetParams
  ): MobileWebAsset {
    if (params.buildId !== verified.manifest.buildId) {
      throw new Error('mobile_web_package_build_changed')
    }
    const asset = verified.assetsByPath.get(params.path)
    if (!asset) {
      throw new Error('mobile_web_package_asset_unknown')
    }
    if (params.offset >= asset.byteLength || params.offset % MOBILE_WEB_PACKAGE_CHUNK_BYTES !== 0) {
      throw new Error('mobile_web_package_offset_invalid')
    }
    return asset
  }

  private acquireRead(connectionId: string, bytes: number): () => void {
    const state = this.readStates.get(connectionId) ?? { count: 0, bytes: 0 }
    if (
      state.count >= MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS ||
      state.bytes + bytes > MOBILE_WEB_PACKAGE_MAX_IN_FLIGHT_BYTES
    ) {
      throw new Error('mobile_web_package_read_limited')
    }
    state.count += 1
    state.bytes += bytes
    this.readStates.set(connectionId, state)
    return () => {
      state.count -= 1
      state.bytes -= bytes
      if (state.count === 0) {
        this.readStates.delete(connectionId)
      }
    }
  }
}

export const mobileWebPackageAssets = new MobileWebPackageAssets()

// Why: gzip buys nothing on a PNG or a woff2, and level 6 expands such a range past the
// declared ceiling. Stored blocks are the smallest framing deflate has for it.
function compressAssetRange(bytes: Buffer): Buffer {
  const deflated = gzipSync(bytes, { level: 6 })
  return deflated.byteLength < bytes.byteLength ? deflated : gzipSync(bytes, { level: 0 })
}
