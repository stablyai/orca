import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  serializeMobileWebManifestForBuildId,
  type MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import type { RpcResponse } from '../transport/types'
import {
  downloadMobileWebPackage,
  type MobileWebPackageRequest,
  type MobileWebPackageStager
} from './mobile-web-package-downloader'

describe('mobile web package download abort sites', () => {
  it('stages and commits when the download is never aborted', async () => {
    const fixture = createFixture()
    const stager = createStager()

    await downloadMobileWebPackage(fixture.request, stager, { shellBridgeVersion: 1 })

    expect(stager.begin).toHaveBeenCalledOnce()
    expect(stager.commit).toHaveBeenCalledOnce()
  })

  it('never asks the host for a manifest when the signal is already aborted', async () => {
    const fixture = createFixture()
    const stager = createStager()
    const controller = new AbortController()
    controller.abort()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' })

    expect(fixture.request).not.toHaveBeenCalled()
    expect(stager.begin).not.toHaveBeenCalled()
    expect(stager.commit).not.toHaveBeenCalled()
  })

  it('never begins staging when the host epoch flips during the manifest read', async () => {
    const controller = new AbortController()
    const fixture = createFixture({ afterManifest: () => controller.abort() })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' })

    expect(stager.begin).not.toHaveBeenCalled()
    expect(stager.commit).not.toHaveBeenCalled()
  })

  it('refuses to report a reused build when the abort lands during the reuse check', async () => {
    const controller = new AbortController()
    const fixture = createFixture()
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        signal: controller.signal,
        reuseVerifiedBuild: () => {
          controller.abort()
          return true
        }
      })
    ).rejects.toMatchObject({ code: 'cancelled' })

    expect(stager.begin).not.toHaveBeenCalled()
  })

  it('never commits a staged package when the abort lands after the last asset', async () => {
    const controller = new AbortController()
    const fixture = createFixture()
    // The chunk pipeline's own abort check runs before this, so only the downloader's
    // pre-commit check can catch an abort raised here.
    const stager = createStager(() => controller.abort())

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' })

    expect(stager.begin).toHaveBeenCalledOnce()
    expect(stager.commit).not.toHaveBeenCalled()
    expect(stager.abort).toHaveBeenCalledOnce()
  })
})

function createFixture(hooks: { afterManifest?: () => void } = {}): {
  manifest: MobileWebManifest
  request: MobileWebPackageRequest
} {
  const document = Buffer.from('<!doctype html><title>Orca</title>')
  const assets = [
    {
      path: 'index.html',
      sha256: sha256Hex(document),
      byteLength: document.byteLength,
      contentType: 'text/html; charset=utf-8' as const,
      role: 'document' as const
    }
  ]
  const seed: MobileWebManifest = {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: '0'.repeat(64),
    bridge: { minimum: 1, testedThrough: 2 },
    entrypoint: 'index.html',
    totalBytes: document.byteLength,
    assets
  }
  const manifest = {
    ...seed,
    buildId: sha256Hex(Buffer.from(serializeMobileWebManifestForBuildId(seed)))
  }
  const request = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'mobileWeb.package.manifest') {
      const response = success({ manifest, chunkBytes: MOBILE_WEB_PACKAGE_CHUNK_BYTES })
      hooks.afterManifest?.()
      return response
    }
    const assetParams = params as { buildId: string; path: string; offset: number }
    const response = success({
      buildId: assetParams.buildId,
      path: assetParams.path,
      offset: assetParams.offset,
      byteLength: document.byteLength,
      sha256: sha256Hex(document),
      dataBase64: Buffer.from(document).toString('base64'),
      eof: true
    })
    return response
  })
  return { manifest, request }
}

function createStager(onFinishAsset: () => void = () => {}) {
  return {
    begin: vi.fn(async () => {}),
    writeAssetChunk: vi.fn(async () => {}),
    finishAsset: vi.fn(async () => onFinishAsset()),
    commit: vi.fn(async (manifest: MobileWebManifest) => ({ generation: manifest.buildId })),
    abort: vi.fn(async () => {})
  } satisfies MobileWebPackageStager<{ generation: string }>
}

function success(result: unknown): RpcResponse {
  return { id: 'request', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}
