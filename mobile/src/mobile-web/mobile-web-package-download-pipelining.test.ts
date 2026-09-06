import { Buffer } from 'buffer/'
import { randomBytes } from 'node:crypto'
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
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
} from '../../../src/shared/mobile-web/package-rpc-contract'
import type { RpcResponse } from '../transport/types'
import {
  downloadMobileWebPackage,
  type MobileWebPackageRequest,
  type MobileWebPackageStager
} from './mobile-web-package-downloader'

type AssetParams = { buildId: string; path: string; offset: number; length?: number }

type Fixture = {
  manifest: MobileWebManifest
  bytesByPath: Map<string, Uint8Array>
  request: MobileWebPackageRequest
  paramsByCall: AssetParams[]
  peakInFlight: () => number
}

describe('mobile web package download pipelining', () => {
  it('overlaps chunk reads while staging them in ascending offset order', async () => {
    const fixture = createFixture()
    const stager = createStager()

    await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1,
      maxConcurrentRequests: 4
    })

    expect(fixture.peakInFlight()).toBe(4)
    expectStagedInOrder(fixture, stager)
  })

  it('defaults to the host per-connection read budget', async () => {
    const fixture = createFixture()

    await downloadMobileWebPackage(fixture.request, createStager(), { shellBridgeVersion: 1 })

    expect(fixture.peakInFlight()).toBe(MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS)
  })

  it('never exceeds the host read budget even when asked for more', async () => {
    const fixture = createFixture()

    await downloadMobileWebPackage(fixture.request, createStager(), {
      shellBridgeVersion: 1,
      maxConcurrentRequests: 64
    })

    expect(fixture.peakInFlight()).toBe(MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS)
  })

  it('reads one chunk at a time when concurrency is disabled', async () => {
    const fixture = createFixture()

    await downloadMobileWebPackage(fixture.request, createStager(), {
      shellBridgeVersion: 1,
      maxConcurrentRequests: 1
    })

    expect(fixture.peakInFlight()).toBe(1)
  })

  it('narrows the pipeline instead of failing when the host limits reads', async () => {
    const fixture = createFixture({ readLimitedCalls: 3 })
    const stager = createStager()

    await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1,
      maxConcurrentRequests: 4
    })

    expect(fixture.paramsByCall.length).toBeGreaterThan(chunkCount(fixture.manifest))
    expectStagedInOrder(fixture, stager)
  })

  it('gives up on a host that never stops limiting reads', async () => {
    const fixture = createFixture({ readLimitedCalls: Number.POSITIVE_INFINITY })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, { shellBridgeVersion: 1 })
    ).rejects.toMatchObject({ code: 'mobile_web_package_read_limited' })
    expect(stager.abort).toHaveBeenCalledOnce()
  })

  it('aborts a pipelined download without committing the stage', async () => {
    const fixture = createFixture()
    const stager = createStager()
    const controller = new AbortController()
    stager.writeAssetChunk.mockImplementation(async () => controller.abort())

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        signal: controller.signal,
        maxConcurrentRequests: 4
      })
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(stager.commit).not.toHaveBeenCalled()
    expect(stager.abort).toHaveBeenCalledOnce()

    // Backgrounding aborts the same way, and nothing survives it: the retry re-reads offset 0.
    fixture.paramsByCall.length = 0
    await downloadMobileWebPackage(fixture.request, createStager(), { shellBridgeVersion: 1 })
    expect(fixture.paramsByCall[0]?.offset).toBe(0)
  })

  it('requests a multi-chunk gzip range and stages it one chunk at a time', async () => {
    const fixture = createFixture()
    const stager = createStager()

    await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1,
      useGzip: true,
      rangeBytes: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
    })

    expect(
      fixture.paramsByCall.every((params) => params.length === MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
    ).toBe(true)
    expect(fixture.paramsByCall.length).toBeLessThan(chunkCount(fixture.manifest))
    expectStagedInOrder(fixture, stager)
    expect(
      stager.writeAssetChunk.mock.calls.every(
        (call) => call[2].byteLength <= MOBILE_WEB_PACKAGE_CHUNK_BYTES
      )
    ).toBe(true)
  })

  it('omits the range length unless the host advertised range reads', async () => {
    const fixture = createFixture()

    await downloadMobileWebPackage(fixture.request, createStager(), {
      shellBridgeVersion: 1,
      useGzip: true
    })

    expect(fixture.paramsByCall.every((params) => params.length === undefined)).toBe(true)
  })

  it('keeps ranged reads off the raw chunk method', async () => {
    const fixture = createFixture()

    await downloadMobileWebPackage(fixture.request, createStager(), {
      shellBridgeVersion: 1,
      rangeBytes: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
    })

    expect(fixture.paramsByCall.every((params) => params.length === undefined)).toBe(true)
    expect(fixture.paramsByCall.length).toBe(chunkCount(fixture.manifest))
  })

  // A PNG/woff2 range gzips larger than its source, which the page's chunk schema rejected while
  // its ceiling was a flat +64 over the range — the download failed on `invalid_chunk`.
  it('accepts a full incompressible range that gzip expands', async () => {
    const fixture = createFixture({ incompressibleScript: true })
    const stager = createStager()

    await downloadMobileWebPackage(fixture.request, stager, {
      shellBridgeVersion: 1,
      useGzip: true,
      rangeBytes: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
    })

    expect(stager.abort).not.toHaveBeenCalled()
    expectStagedInOrder(fixture, stager)
  })

  it('rejects a ranged asset whose bytes do not hash to the manifest entry', async () => {
    const fixture = createFixture({ alterLastRangeByte: true })
    const stager = createStager()

    await expect(
      downloadMobileWebPackage(fixture.request, stager, {
        shellBridgeVersion: 1,
        useGzip: true,
        rangeBytes: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
      })
    ).rejects.toMatchObject({ code: 'asset_integrity_failed' })
    expect(stager.abort).toHaveBeenCalledOnce()
  })
})

function expectStagedInOrder(fixture: Fixture, stager: ReturnType<typeof createStager>): void {
  const stagedByPath = new Map<string, Buffer[]>()
  for (const [asset, offset, bytes] of stager.writeAssetChunk.mock.calls) {
    const staged = stagedByPath.get(asset.path) ?? []
    expect(offset).toBe(staged.reduce((total, part) => total + part.byteLength, 0))
    staged.push(Buffer.from(bytes))
    stagedByPath.set(asset.path, staged)
  }
  for (const [path, staged] of stagedByPath) {
    expect(Buffer.concat(staged)).toEqual(Buffer.from(fixture.bytesByPath.get(path)!))
  }
  expect([...stagedByPath.keys()].sort()).toEqual(
    fixture.manifest.assets.map((asset) => asset.path).sort()
  )
}

function chunkCount(manifest: MobileWebManifest): number {
  return manifest.assets.reduce(
    (total, asset) => total + Math.ceil(asset.byteLength / MOBILE_WEB_PACKAGE_CHUNK_BYTES),
    0
  )
}

function createFixture(
  options: {
    readLimitedCalls?: number
    alterLastRangeByte?: boolean
    incompressibleScript?: boolean
  } = {}
): Fixture {
  const document = Buffer.from('<!doctype html><title>Orca</title>')
  const scriptBytes = MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES + MOBILE_WEB_PACKAGE_CHUNK_BYTES + 11
  const script = options.incompressibleScript
    ? Buffer.from(randomBytes(scriptBytes))
    : Buffer.alloc(scriptBytes, 0x61)
  const assets: MobileWebAsset[] = [
    asset('index.html', document, 'text/html; charset=utf-8', 'document'),
    asset(`assets/${sha256Hex(script)}.js`, script, 'text/javascript; charset=utf-8', 'script')
  ].sort((left, right) => left.path.localeCompare(right.path))
  const seed: MobileWebManifest = {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: '0'.repeat(64),
    bridge: { minimum: 1, testedThrough: 2 },
    entrypoint: 'index.html',
    totalBytes: assets.reduce((total, candidate) => total + candidate.byteLength, 0),
    assets
  }
  const manifest = {
    ...seed,
    buildId: sha256Hex(Buffer.from(serializeMobileWebManifestForBuildId(seed)))
  }
  const bytesByPath = new Map([
    ['index.html', document as unknown as Uint8Array],
    [assets.find((candidate) => candidate.role === 'script')!.path, script as unknown as Uint8Array]
  ])
  const paramsByCall: AssetParams[] = []
  let readLimitedRemaining = options.readLimitedCalls ?? 0
  let inFlight = 0
  let peakInFlight = 0

  const request = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'mobileWeb.package.manifest') {
      return success({ manifest, chunkBytes: MOBILE_WEB_PACKAGE_CHUNK_BYTES })
    }
    const assetParams = params as AssetParams
    paramsByCall.push(assetParams)
    inFlight += 1
    peakInFlight = Math.max(peakInFlight, inFlight)
    try {
      // Why: a real host answers overlapping reads out of order, so the drain path has to
      // reorder rather than rely on the request order.
      await new Promise((resolve) => setTimeout(resolve, 5 - (paramsByCall.length % 5)))
      if (readLimitedRemaining > 0) {
        readLimitedRemaining -= 1
        return failure('mobile_web_package_read_limited')
      }
      const bytes = bytesByPath.get(assetParams.path)!
      const requested = assetParams.length ?? MOBILE_WEB_PACKAGE_CHUNK_BYTES
      const source = Buffer.from(bytes).subarray(
        assetParams.offset,
        Math.min(assetParams.offset + requested, bytes.byteLength)
      )
      const eof = assetParams.offset + source.byteLength === bytes.byteLength
      const payload =
        options.alterLastRangeByte && eof && source.byteLength > 1
          ? Buffer.from(source).fill(0x62, source.byteLength - 1)
          : source
      if (method !== 'mobileWeb.package.asset.gzip') {
        return success({
          buildId: assetParams.buildId,
          path: assetParams.path,
          offset: assetParams.offset,
          byteLength: payload.byteLength,
          sha256: sha256Hex(payload),
          dataBase64: Buffer.from(payload).toString('base64'),
          eof
        })
      }
      const encoded = gzipSync(Buffer.from(payload), { mtime: 0 })
      return success({
        buildId: assetParams.buildId,
        path: assetParams.path,
        offset: assetParams.offset,
        sourceByteLength: payload.byteLength,
        byteLength: encoded.byteLength,
        sha256: sha256Hex(encoded),
        dataBase64: Buffer.from(encoded).toString('base64'),
        eof,
        encoding: 'gzip'
      })
    } finally {
      inFlight -= 1
    }
  })
  return { manifest, bytesByPath, request, paramsByCall, peakInFlight: () => peakInFlight }
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

function failure(message: string): RpcResponse {
  return {
    id: 'request',
    ok: false,
    error: { code: 'invalid_argument', message },
    _meta: { runtimeId: 'runtime' }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}
