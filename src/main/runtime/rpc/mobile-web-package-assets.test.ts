import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  type MobileWebPackageAssetParams
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

describe('mobile web package assets', () => {
  it('verifies a package and serves every asset in bounded aligned chunks', async () => {
    const fixture = await createPackageFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const response = await assets.getManifest()

    expect(response.manifest).toEqual(fixture.manifest)
    expect(response.chunkBytes).toBe(MOBILE_WEB_PACKAGE_CHUNK_BYTES)

    for (const asset of fixture.manifest.assets) {
      const chunks: Buffer[] = []
      for (let offset = 0; offset < asset.byteLength; offset += response.chunkBytes) {
        const chunk = await assets.getAssetChunk(
          { buildId: fixture.manifest.buildId, path: asset.path, offset },
          { connectionId: 'connection-1' }
        )
        const bytes = Buffer.from(chunk.dataBase64, 'base64')
        expect(chunk.sha256).toBe(sha256(bytes))
        expect(chunk.byteLength).toBeLessThanOrEqual(MOBILE_WEB_PACKAGE_CHUNK_BYTES)
        expect(chunk.eof).toBe(offset + chunk.byteLength === asset.byteLength)
        chunks.push(bytes)
      }
      expect(sha256(Buffer.concat(chunks))).toBe(asset.sha256)
    }
  })

  it('serves gzip chunks that round-trip to the manifest bytes', async () => {
    const fixture = await createPackageFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const asset = fixture.manifest.assets.find((candidate) => candidate.role === 'script')!
    const chunks: Buffer[] = []

    for (let offset = 0; offset < asset.byteLength; offset += MOBILE_WEB_PACKAGE_CHUNK_BYTES) {
      const chunk = await assets.getAssetGzipChunk({
        buildId: fixture.manifest.buildId,
        path: asset.path,
        offset
      })
      expect(chunk.encoding).toBe('gzip')
      const compressed = Buffer.from(chunk.dataBase64, 'base64')
      expect(chunk.sha256).toBe(sha256(compressed))
      expect(chunk.byteLength).toBe(compressed.byteLength)
      expect(chunk.sourceByteLength).toBe(
        Math.min(MOBILE_WEB_PACKAGE_CHUNK_BYTES, asset.byteLength - offset)
      )
      chunks.push(compressed)
    }

    const { gunzipSync } = await import('node:zlib')
    expect(sha256(Buffer.concat(chunks.map((chunk) => gunzipSync(chunk))))).toBe(asset.sha256)
  })

  it('validates gzip cache keys and detects changed files', async () => {
    const fixture = await createPackageFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const asset = fixture.manifest.assets[0]!
    const request = { buildId: fixture.manifest.buildId, path: asset.path, offset: 0 }

    await assets.getAssetGzipChunk(request)
    await expect(assets.getAssetGzipChunk({ ...request, offset: 1 })).rejects.toThrow(
      'mobile_web_package_offset_invalid'
    )
    await writeFile(
      join(fixture.root, ...asset.path.split('/')),
      Buffer.alloc(asset.byteLength, 0x62)
    )
    await expect(assets.getAssetGzipChunk(request)).rejects.toThrow(
      'mobile_web_package_asset_changed'
    )
  })

  it('rejects stale builds, undeclared paths, unaligned offsets, and cancelled reads', async () => {
    const fixture = await createPackageFixture()
    const assets = new MobileWebPackageAssets({ resolveRoot: () => fixture.root })
    const asset = fixture.manifest.assets[0]!
    const request = { buildId: fixture.manifest.buildId, path: asset.path, offset: 0 }

    await expect(assets.getAssetChunk({ ...request, buildId: '0'.repeat(64) })).rejects.toThrow(
      'mobile_web_package_build_changed'
    )
    await expect(assets.getAssetChunk({ ...request, path: '../secret' })).rejects.toThrow(
      'mobile_web_package_asset_unknown'
    )
    await expect(assets.getAssetChunk({ ...request, offset: 1 })).rejects.toThrow(
      'mobile_web_package_offset_invalid'
    )
    const controller = new AbortController()
    controller.abort()
    await expect(assets.getAssetChunk(request, { signal: controller.signal })).rejects.toThrow(
      'mobile_web_package_cancelled'
    )
  })

  it('rejects an invalid build identity and corrupt asset before serving the manifest', async () => {
    const invalidBuild = await createPackageFixture()
    await rewriteManifest(invalidBuild.root, { ...invalidBuild.manifest, buildId: '0'.repeat(64) })
    await expect(
      new MobileWebPackageAssets({ resolveRoot: () => invalidBuild.root }).getManifest()
    ).rejects.toThrow('mobile_web_package_build_invalid')

    const corrupt = await createPackageFixture()
    const script = corrupt.manifest.assets.find((asset) => asset.role === 'script')!
    await writeFile(
      join(corrupt.root, ...script.path.split('/')),
      Buffer.alloc(script.byteLength, 1)
    )
    await expect(
      new MobileWebPackageAssets({ resolveRoot: () => corrupt.root }).getManifest()
    ).rejects.toThrow('mobile_web_package_asset_invalid')
  })

  it('rejects malformed manifests with a stable build error', async () => {
    const fixture = await createPackageFixture()
    await writeFile(join(fixture.root, 'manifest.json'), '{')

    await expect(
      new MobileWebPackageAssets({ resolveRoot: () => fixture.root }).getManifest()
    ).rejects.toThrow('mobile_web_package_build_invalid')
  })

  it('rejects a partial range read instead of returning an incomplete chunk', async () => {
    const fixture = await createPackageFixture()
    const asset = fixture.manifest.assets.find((candidate) => candidate.role === 'script')!
    const assets = new MobileWebPackageAssets({
      resolveRoot: () => fixture.root,
      readAssetRange: async (_path, _offset, length) => Buffer.alloc(length - 1)
    })
    await assets.getManifest()
    await expect(
      assets.getAssetChunk({
        buildId: fixture.manifest.buildId,
        path: asset.path,
        offset: 0
      })
    ).rejects.toThrow('mobile_web_package_asset_truncated')
  })

  it('rejects a chunk when the manifest changes during its read', async () => {
    const fixture = await createPackageFixture()
    const asset = fixture.manifest.assets.find((candidate) => candidate.role === 'script')!
    const assets = new MobileWebPackageAssets({
      resolveRoot: () => fixture.root,
      readAssetRange: async (path, offset, length) => {
        await writeFile(join(fixture.root, 'manifest.json'), '{}')
        const bytes = await readFile(path)
        return bytes.subarray(offset, offset + length)
      }
    })
    await assets.getManifest()

    await expect(
      assets.getAssetChunk({
        buildId: fixture.manifest.buildId,
        path: asset.path,
        offset: 0
      })
    ).rejects.toThrow('mobile_web_package_build_changed')
  })

  it('rejects excess concurrent reads per connection and releases completed slots', async () => {
    const fixture = await createPackageFixture()
    const asset = fixture.manifest.assets.find((candidate) => candidate.role === 'script')!
    let releaseReads = (): void => {}
    const readsMayFinish = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    let startedReads = 0
    let markReadsStarted = (): void => {}
    const readsStarted = new Promise<void>((resolve) => {
      markReadsStarted = resolve
    })
    const assets = new MobileWebPackageAssets({
      resolveRoot: () => fixture.root,
      readAssetRange: async (path, offset, length) => {
        startedReads += 1
        if (startedReads === MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS) {
          markReadsStarted()
        }
        await readsMayFinish
        const bytes = await readFile(path)
        return bytes.subarray(offset, offset + length)
      }
    })
    await assets.getManifest()
    const request: MobileWebPackageAssetParams = {
      buildId: fixture.manifest.buildId,
      path: asset.path,
      offset: 0
    }
    const active = Array.from({ length: MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS }, () =>
      assets.getAssetChunk(request, { connectionId: 'connection-1' })
    )
    await readsStarted
    await expect(assets.getAssetChunk(request, { connectionId: 'connection-1' })).rejects.toThrow(
      'mobile_web_package_read_limited'
    )
    releaseReads()
    await expect(Promise.all(active)).resolves.toHaveLength(MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS)
    await expect(
      assets.getAssetChunk(request, { connectionId: 'connection-1' })
    ).resolves.toBeDefined()
  })
})

async function createPackageFixture(): Promise<{ root: string; manifest: MobileWebManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-mobile-web-package-'))
  temporaryRoots.push(root)
  const scriptBytes = Buffer.alloc(MOBILE_WEB_PACKAGE_CHUNK_BYTES + 17, 0x61)
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
  const manifestSeed: MobileWebManifest = {
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
  const manifest = {
    ...manifestSeed,
    buildId: sha256(serializeMobileWebManifestForBuildId(manifestSeed))
  }
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, ...assets[0]!.path.split('/')), scriptBytes)
  await writeFile(join(root, 'index.html'), documentBytes)
  await rewriteManifest(root, manifest)
  return { root, manifest }
}

async function rewriteManifest(root: string, manifest: MobileWebManifest): Promise<void> {
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
