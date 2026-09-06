import { Buffer } from 'buffer/'
import { gzipSync } from 'node:zlib'
import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  serializeMobileWebManifestForBuildId,
  type MobileWebAsset,
  type MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import type { RpcResponse } from '../transport/types'
import {
  MobileWebPackageDownloadError,
  downloadMobileWebPackage,
  mobileWebPackageDownloadFailureCode,
  type MobileWebPackageRequest,
  type MobileWebPackageStager
} from './mobile-web-package-downloader'

type Fixture = {
  manifest: MobileWebManifest
  bytesByPath: Map<string, Uint8Array>
  request: MobileWebPackageRequest
}

describe('mobile web package downloader', () => {
  it('reports only stable package failure codes to diagnostics', () => {
    expect(
      mobileWebPackageDownloadFailureCode(new MobileWebPackageDownloadError('invalid_manifest'))
    ).toBe('invalid_manifest')
    expect(mobileWebPackageDownloadFailureCode(new Error('/private/host/path'))).toBe(
      'native_session_error'
    )
  })

  it('validates and stages every package asset in bounded chunks', async () => {
    const fixture = createFixture()
    const stager = createStager()

    const result = await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1
    })

    expect(result.manifest).toEqual(fixture.manifest)
    expect(result.commit).toEqual({ generation: fixture.manifest.buildId })
    expect(stager.begin).toHaveBeenCalledOnce()
    expect(stager.finishAsset).toHaveBeenCalledTimes(fixture.manifest.assets.length)
    expect(stager.commit).toHaveBeenCalledOnce()
    expect(stager.abort).not.toHaveBeenCalled()
    const written = Buffer.concat(
      stager.writeAssetChunk.mock.calls.map((call) => Buffer.from(call[2]))
    )
    expect(written.byteLength).toBe(fixture.manifest.totalBytes)
  })

  it('decodes and stages gzip package chunks when the host advertises gzip', async () => {
    const fixture = createFixture()
    const stager = createStager()

    const result = await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1,
      useGzip: true
    })

    expect(result.commit).toEqual({ generation: fixture.manifest.buildId })
    expect(fixture.request).toHaveBeenCalledWith(
      'mobileWeb.package.asset.gzip',
      expect.objectContaining({ path: 'index.html', offset: 0 })
    )
    expect(stager.writeAssetChunk).toHaveBeenCalledTimes(3)
  })

  it('reports source-byte progress through verification and activation', async () => {
    const fixture = createFixture()
    const stager = createStager()
    const progress: string[] = []

    await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1,
      onProgress: ({ phase, completedBytes, totalBytes }) =>
        progress.push(`${phase}:${completedBytes}/${totalBytes}`)
    })

    expect(progress[0]).toBe(`downloading:0/${fixture.manifest.totalBytes}`)
    expect(progress.at(-2)).toBe(
      `verifying:${fixture.manifest.totalBytes}/${fixture.manifest.totalBytes}`
    )
    expect(progress.at(-1)).toBe(
      `activating:${fixture.manifest.totalBytes}/${fixture.manifest.totalBytes}`
    )
  })

  it('rejects gzip chunks with corrupt compressed bytes', async () => {
    const fixture = createFixture({ corruptGzipChunk: true })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        useGzip: true
      })
    ).rejects.toMatchObject({ code: 'invalid_chunk' })
    expect(stager.abort).toHaveBeenCalledOnce()
  })

  it('rejects gzip output that exceeds the advertised raw chunk', async () => {
    const fixture = createFixture({ gzipOversizedOutput: true })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        useGzip: true
      })
    ).rejects.toMatchObject({ code: 'invalid_chunk' })
    expect(stager.abort).toHaveBeenCalledOnce()
  })

  it('reuses an independently verified matching build before staging', async () => {
    const fixture = createFixture()
    const stager = createStager()
    const reuseVerifiedBuild = vi.fn(async () => true)

    const result = await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1,
      reuseVerifiedBuild
    })

    expect(result).toEqual({
      manifest: fixture.manifest,
      commit: null,
      reusedVerifiedBuild: true
    })
    expect(reuseVerifiedBuild).toHaveBeenCalledWith(fixture.manifest.buildId)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(stager.begin).not.toHaveBeenCalled()
    expect(stager.writeAssetChunk).not.toHaveBeenCalled()
    expect(stager.commit).not.toHaveBeenCalled()
  })

  it('rejects a non-canonical manifest build identity before staging', async () => {
    const fixture = createFixture({ invalidBuildIdentity: true })
    const stager = createStager()
    const reuseVerifiedBuild = vi.fn(async () => true)

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        reuseVerifiedBuild
      })
    ).rejects.toMatchObject({ code: 'invalid_manifest' })
    expect(reuseVerifiedBuild).not.toHaveBeenCalled()
    expect(stager.begin).not.toHaveBeenCalled()
  })

  it('rejects a package requiring a newer native bridge before staging', async () => {
    const fixture = createFixture({ bridgeMinimum: 2 })
    const stager = createStager()
    const reuseVerifiedBuild = vi.fn(async () => true)

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        reuseVerifiedBuild
      })
    ).rejects.toMatchObject({ code: 'incompatible_bridge' })
    expect(reuseVerifiedBuild).not.toHaveBeenCalled()
    expect(stager.begin).not.toHaveBeenCalled()
  })

  it('rejects a package not tested through the current native bridge before staging', async () => {
    const fixture = createFixture({ bridgeTestedThrough: 1 })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, { shellBridgeVersion: 2 })
    ).rejects.toMatchObject({ code: 'incompatible_bridge' })
    expect(stager.begin).not.toHaveBeenCalled()
  })

  it('aborts staging when a chunk fails integrity validation', async () => {
    const fixture = createFixture({ corruptFirstChunk: true })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, { shellBridgeVersion: 1 })
    ).rejects.toMatchObject({ code: 'invalid_chunk' })
    expect(stager.abort).toHaveBeenCalledOnce()
    expect(stager.commit).not.toHaveBeenCalled()
  })

  it('rejects an asset whose valid chunks do not match its manifest hash', async () => {
    const fixture = createFixture({ alterFirstChunkWithMatchingHash: true })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, { shellBridgeVersion: 1 })
    ).rejects.toMatchObject({ code: 'asset_integrity_failed' })
    expect(stager.abort).toHaveBeenCalledOnce()
    expect(stager.finishAsset).not.toHaveBeenCalled()
  })

  it.each(['writeAssetChunk', 'finishAsset', 'commit'] as const)(
    'aborts partial staging when %s fails',
    async (method) => {
      const fixture = createFixture()
      const stager = createStager()
      stager[method].mockRejectedValueOnce(new Error('native storage detail'))

      await expect(
        downloadMobileWebPackage(fixture.request, stager, { shellBridgeVersion: 1 })
      ).rejects.toMatchObject({ code: 'staging_failed' })
      expect(stager.abort).toHaveBeenCalledOnce()
    }
  )

  it('does not let abort cleanup failure mask the classified staging failure', async () => {
    const fixture = createFixture({ corruptFirstChunk: true })
    const stager = createStager()
    stager.abort.mockRejectedValueOnce(new Error('cleanup detail'))

    await expect(
      downloadMobileWebPackage(fixture.request, stager, { shellBridgeVersion: 1 })
    ).rejects.toMatchObject({ code: 'invalid_chunk' })
  })

  it('aborts staging when the selected host session is cancelled', async () => {
    const controller = new AbortController()
    const fixture = createFixture({ afterFirstChunk: () => controller.abort() })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(stager.abort).toHaveBeenCalledOnce()
    expect(stager.commit).not.toHaveBeenCalled()
  })

  it('never forwards an unexpected host error string', async () => {
    const stager = createStager()
    const request = vi.fn(async (): Promise<RpcResponse> => failure('/private/cache denied'))

    await expect(
      downloadMobileWebPackage(request, stager, { shellBridgeVersion: 1 })
    ).rejects.toEqual(new MobileWebPackageDownloadError('host_rejected_request'))
  })

  it('maps host protocol failures to stable diagnostic categories', async () => {
    const stager = createStager()
    const request = vi.fn(async (): Promise<RpcResponse> =>
      failure('Unknown method with host details', 'method_not_found')
    )

    await expect(
      downloadMobileWebPackage(request, stager, { shellBridgeVersion: 1 })
    ).rejects.toEqual(new MobileWebPackageDownloadError('host_method_unavailable'))
  })
  // A relay/direct cutover rejects in-flight requests without changing connState, so no effect
  // upstream re-runs the download: without a retry here the user is left tapping Retry by hand.
  it('rides out a logical-session cutover on the manifest read and on a chunk read', async () => {
    const fixture = createFixture({ manifestCutoverFailures: 1, chunkCutoverFailures: 1 })
    const stager = createStager()

    const result = await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1
    })

    expect(result.manifest).toEqual(fixture.manifest)
    expect(stager.commit).toHaveBeenCalledOnce()
    expect(stager.abort).not.toHaveBeenCalled()
  })

  it('still fails when the cutovers outlast the bounded retry', async () => {
    const fixture = createFixture({ manifestCutoverFailures: 99 })

    await expect(
      downloadMobileWebPackage(fixture.request, createStager(), { shellBridgeVersion: 1 })
    ).rejects.toMatchObject({ code: 'host_error' })
  })
})

function createFixture(
  options: {
    bridgeMinimum?: number
    bridgeTestedThrough?: number
    corruptFirstChunk?: boolean
    alterFirstChunkWithMatchingHash?: boolean
    corruptGzipChunk?: boolean
    gzipOversizedOutput?: boolean
    invalidBuildIdentity?: boolean
    afterFirstChunk?: () => void
    manifestCutoverFailures?: number
    chunkCutoverFailures?: number
  } = {}
): Fixture {
  const document = Buffer.from('<!doctype html><title>Orca</title>')
  const script = Buffer.alloc(MOBILE_WEB_PACKAGE_CHUNK_BYTES + 7, 0x61)
  const assets: MobileWebAsset[] = [
    asset('index.html', document, 'text/html; charset=utf-8', 'document'),
    asset(`assets/${sha256Hex(script)}.js`, script, 'text/javascript; charset=utf-8', 'script')
  ].sort((left, right) => left.path.localeCompare(right.path))
  const manifestSeed: MobileWebManifest = {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: '0'.repeat(64),
    bridge: {
      minimum: options.bridgeMinimum ?? 1,
      testedThrough: options.bridgeTestedThrough ?? 2
    },
    entrypoint: 'index.html',
    totalBytes: assets.reduce((total, candidate) => total + candidate.byteLength, 0),
    assets
  }
  const manifest = {
    ...manifestSeed,
    buildId: sha256Hex(Buffer.from(serializeMobileWebManifestForBuildId(manifestSeed)))
  }
  const bytesByPath = new Map([
    ['index.html', document],
    [assets.find((candidate) => candidate.role === 'script')!.path, script]
  ])
  let chunkCount = 0
  let manifestCutovers = 0
  let chunkCutovers = 0
  const request = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'mobileWeb.package.manifest') {
      if (manifestCutovers < (options.manifestCutoverFailures ?? 0)) {
        manifestCutovers += 1
        throw new Error('RPC interrupted by connection migration')
      }
      return success({
        manifest: options.invalidBuildIdentity
          ? { ...manifest, buildId: 'f'.repeat(64) }
          : manifest,
        chunkBytes: MOBILE_WEB_PACKAGE_CHUNK_BYTES
      })
    }
    if (chunkCutovers < (options.chunkCutoverFailures ?? 0)) {
      chunkCutovers += 1
      throw new Error('RPC interrupted by connection migration')
    }
    const assetParams = params as { buildId: string; path: string; offset: number }
    const bytes = bytesByPath.get(assetParams.path)!
    const chunk = bytes.subarray(
      assetParams.offset,
      Math.min(assetParams.offset + MOBILE_WEB_PACKAGE_CHUNK_BYTES, bytes.byteLength)
    )
    chunkCount += 1
    const data =
      options.corruptFirstChunk && chunkCount === 1
        ? Buffer.from('corrupt')
        : options.alterFirstChunkWithMatchingHash && chunkCount === 1
          ? Buffer.from(chunk).fill(0x62, 0, 1)
          : chunk
    const isGzip = method === 'mobileWeb.package.asset.gzip'
    const gzipSource =
      options.gzipOversizedOutput && chunkCount === 1
        ? Buffer.alloc(MOBILE_WEB_PACKAGE_CHUNK_BYTES + 1, 0x61)
        : data
    const encoded = isGzip ? gzipSync(gzipSource, { mtime: 0 }) : data
    const response = success(
      isGzip
        ? {
            buildId: assetParams.buildId,
            path: assetParams.path,
            offset: assetParams.offset,
            sourceByteLength: chunk.byteLength,
            byteLength: encoded.byteLength,
            sha256: sha256Hex(encoded),
            dataBase64: Buffer.from(
              options.corruptGzipChunk && chunkCount === 1 ? Buffer.from(encoded).fill(0) : encoded
            ).toString('base64'),
            eof: assetParams.offset + chunk.byteLength === bytes.byteLength,
            encoding: 'gzip'
          }
        : {
            buildId: assetParams.buildId,
            path: assetParams.path,
            offset: assetParams.offset,
            byteLength: chunk.byteLength,
            sha256: sha256Hex(
              options.alterFirstChunkWithMatchingHash && chunkCount === 1 ? data : chunk
            ),
            dataBase64: Buffer.from(data).toString('base64'),
            eof: assetParams.offset + chunk.byteLength === bytes.byteLength
          }
    )
    if (chunkCount === 1) {
      options.afterFirstChunk?.()
    }
    return response
  })
  return { manifest, bytesByPath, request }
}

function createStager() {
  return {
    begin: vi.fn(async () => {}),
    writeAssetChunk: vi.fn(async () => {}),
    finishAsset: vi.fn(async () => {}),
    commit: vi.fn(async (manifest: MobileWebManifest) => ({ generation: manifest.buildId })),
    abort: vi.fn(async () => {})
  } satisfies MobileWebPackageStager<{ generation: string }>
}

function asset(
  path: string,
  bytes: Uint8Array,
  contentType: MobileWebAsset['contentType'],
  role: MobileWebAsset['role']
): MobileWebAsset {
  return { path, sha256: sha256Hex(bytes), byteLength: bytes.byteLength, contentType, role }
}

function success(result: unknown): RpcResponse {
  return { id: 'request', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function failure(message: string, code = 'invalid_argument'): RpcResponse {
  return {
    id: 'request',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime' }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}
