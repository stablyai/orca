import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_PACKAGE_GZIP_CHUNK_BYTES,
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES,
  MobileWebPackageAssetParamsSchema
} from '../../../shared/mobile-web/package-rpc-contract'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  serializeMobileWebManifestForBuildId,
  type MobileWebManifest
} from '../../../shared/mobile-web/manifest-contract'
import { MobileWebPackageAssets } from './mobile-web-package-assets'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('mobile web package ranged gzip reads', () => {
  it('answers a whole multi-chunk range in one response', async () => {
    const fixture = await createRangeFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const script = fixture.manifest.assets.find((asset) => asset.role === 'script')!

    const chunk = await assets.getAssetGzipChunk(
      {
        buildId: fixture.manifest.buildId,
        path: script.path,
        offset: 0,
        length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
      },
      { connectionId: 'connection-1' }
    )

    expect(chunk.sourceByteLength).toBe(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
    expect(chunk.eof).toBe(false)
    const bytes = gunzipSync(Buffer.from(chunk.dataBase64, 'base64'))
    expect(bytes).toEqual(fixture.scriptBytes.subarray(0, MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES))
  })

  it('clamps the last range to the end of the asset', async () => {
    const fixture = await createRangeFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const script = fixture.manifest.assets.find((asset) => asset.role === 'script')!
    const offset = MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES

    const chunk = await assets.getAssetGzipChunk({
      buildId: fixture.manifest.buildId,
      path: script.path,
      offset,
      length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
    })

    expect(chunk.sourceByteLength).toBe(script.byteLength - offset)
    expect(chunk.eof).toBe(true)
    expect(gunzipSync(Buffer.from(chunk.dataBase64, 'base64'))).toEqual(
      fixture.scriptBytes.subarray(offset)
    )
  })

  it('reproduces a cached range byte for byte', async () => {
    const fixture = await createRangeFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const script = fixture.manifest.assets.find((asset) => asset.role === 'script')!
    const params = {
      buildId: fixture.manifest.buildId,
      path: script.path,
      offset: 0,
      length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
    }

    const first = await assets.getAssetGzipChunk(params)
    const second = await assets.getAssetGzipChunk(params)

    expect(second).toEqual(first)
  })

  it('evicts the least recently used range once the gzip cache is full', async () => {
    const fixture = await createRangeFixture()
    const script = fixture.manifest.assets.find((asset) => asset.role === 'script')!
    const length = 4 * MOBILE_WEB_PACKAGE_CHUNK_BYTES
    const first = { buildId: fixture.manifest.buildId, path: script.path, offset: 0, length }
    const second = { ...first, offset: MOBILE_WEB_PACKAGE_CHUNK_BYTES }
    // Both ranges are the same run of identical bytes, so one cached entry is the cap.
    const sized = await new MobileWebPackageAssets({
      resolveRoot: () => fixture.root
    }).getAssetGzipChunk(first)
    let reads = 0
    const assets = new MobileWebPackageAssets({
      resolveRoot: () => fixture.root,
      gzipCacheMaxBytes: sized.byteLength,
      readAssetRange: async (path, offset, byteLength) => {
        reads += 1
        return readFile(path).then((bytes) => bytes.subarray(offset, offset + byteLength))
      }
    })

    await assets.getAssetGzipChunk(first)
    await assets.getAssetGzipChunk(first)
    expect(reads).toBe(1)
    await assets.getAssetGzipChunk(second)
    // Caching the second range evicted the first, so it must be read again.
    await assets.getAssetGzipChunk(first)
    expect(reads).toBe(3)
    // The re-read made the first range the most recent, so it stays cached.
    await assets.getAssetGzipChunk(first)
    expect(reads).toBe(3)
  })

  it('keeps a chunk read and a range read at the same offset apart', async () => {
    const fixture = await createRangeFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const script = fixture.manifest.assets.find((asset) => asset.role === 'script')!
    const address = { buildId: fixture.manifest.buildId, path: script.path, offset: 0 }

    const single = await assets.getAssetGzipChunk(address)
    const ranged = await assets.getAssetGzipChunk({
      ...address,
      length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
    })

    expect(single.sourceByteLength).toBe(MOBILE_WEB_PACKAGE_CHUNK_BYTES)
    expect(ranged.sourceByteLength).toBe(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
  })

  it('refuses a ranged read on the uncompressed chunk method', async () => {
    const fixture = await createRangeFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const script = fixture.manifest.assets.find((asset) => asset.role === 'script')!

    await expect(
      assets.getAssetChunk({
        buildId: fixture.manifest.buildId,
        path: script.path,
        offset: 0,
        length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
      })
    ).rejects.toThrow('mobile_web_package_offset_invalid')
  })

  // An incompressible asset (PNG, woff2, wasm) is the case a flat gzip headroom got wrong: level 6
  // expands it, the response failed its own schema, and the whole download aborted.
  it('answers a full incompressible range inside the declared gzip ceiling', async () => {
    const scriptBytes = randomBytes(RANGE_FIXTURE_ASSET_BYTES)
    const fixture = await createRangeFixture(scriptBytes)
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const script = fixture.manifest.assets.find((asset) => asset.role === 'script')!

    const chunk = await assets.getAssetGzipChunk({
      buildId: fixture.manifest.buildId,
      path: script.path,
      offset: 0,
      length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
    })

    expect(chunk.sourceByteLength).toBe(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
    expect(chunk.byteLength).toBeGreaterThan(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
    expect(chunk.byteLength).toBeLessThanOrEqual(MOBILE_WEB_PACKAGE_GZIP_CHUNK_BYTES)
    expect(gunzipSync(Buffer.from(chunk.dataBase64, 'base64'))).toEqual(
      scriptBytes.subarray(0, MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
    )
  })

  it('only accepts chunk-aligned range lengths within the cap', async () => {
    const address = { buildId: '0'.repeat(64), path: 'index.html', offset: 0 }

    expect(
      MobileWebPackageAssetParamsSchema.safeParse({
        ...address,
        length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
      }).success
    ).toBe(true)
    expect(MobileWebPackageAssetParamsSchema.safeParse(address).success).toBe(true)
    expect(
      MobileWebPackageAssetParamsSchema.safeParse({
        ...address,
        length: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES + MOBILE_WEB_PACKAGE_CHUNK_BYTES
      }).success
    ).toBe(false)
    expect(
      MobileWebPackageAssetParamsSchema.safeParse({
        ...address,
        length: MOBILE_WEB_PACKAGE_CHUNK_BYTES + 1
      }).success
    ).toBe(false)
    expect(MobileWebPackageAssetParamsSchema.safeParse({ ...address, length: 0 }).success).toBe(
      false
    )
  })
})

const RANGE_FIXTURE_ASSET_BYTES =
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES + MOBILE_WEB_PACKAGE_CHUNK_BYTES + 23

async function createRangeFixture(
  scriptBytes: Buffer = Buffer.alloc(RANGE_FIXTURE_ASSET_BYTES, 0x61)
): Promise<{
  root: string
  manifest: MobileWebManifest
  scriptBytes: Buffer
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-mobile-web-range-'))
  temporaryRoots.push(root)
  const documentBytes = Buffer.from('<!doctype html><title>Orca</title>', 'utf8')
  const scriptHash = sha256(scriptBytes)
  const assets = [
    {
      path: `assets/${scriptHash}.js`,
      sha256: scriptHash,
      byteLength: scriptBytes.byteLength,
      contentType: 'text/javascript; charset=utf-8' as const,
      role: 'script' as const
    },
    {
      path: 'index.html',
      sha256: sha256(documentBytes),
      byteLength: documentBytes.byteLength,
      contentType: 'text/html; charset=utf-8' as const,
      role: 'document' as const
    }
  ]
  const seed: MobileWebManifest = {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: '0'.repeat(64),
    bridge: {
      minimum: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      testedThrough: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    },
    entrypoint: 'index.html',
    totalBytes: assets.reduce((total, asset) => total + asset.byteLength, 0),
    assets
  }
  const manifest = { ...seed, buildId: sha256(serializeMobileWebManifestForBuildId(seed)) }
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, ...assets[0]!.path.split('/')), scriptBytes)
  await writeFile(join(root, 'index.html'), documentBytes)
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  return { root, manifest, scriptBytes }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
