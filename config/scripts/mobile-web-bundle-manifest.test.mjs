import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeMobileWebBundleBuildId,
  contentTypeForExtension,
  hashedAsset,
  serializeMobileWebBundleAssets,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'
import { MobileWebBundleManifestSchema } from '../../src/shared/mobile-web-bundle/manifest-contract.js'

describe('computeMobileWebBundleBuildId', () => {
  const assets = [
    { path: 'index.html', sha256: 'a'.repeat(64), byteLength: 3, contentType: 'text/html' },
    { path: 'assets/b.js', sha256: 'b'.repeat(64), byteLength: 5, contentType: 'text/javascript' }
  ]

  it('sorts by path, so input order cannot change the id', () => {
    expect(computeMobileWebBundleBuildId(assets.toReversed())).toBe(
      computeMobileWebBundleBuildId(assets)
    )
  })

  it('serializes a fixed key order regardless of the input object key order', () => {
    const reordered = assets.map(({ contentType, byteLength, sha256, path }) => ({
      contentType,
      byteLength,
      sha256,
      path
    }))
    expect(serializeMobileWebBundleAssets(reordered)).toBe(serializeMobileWebBundleAssets(assets))
  })

  it('changes when any hashed field changes', () => {
    const baseline = computeMobileWebBundleBuildId(assets)
    for (const field of ['sha256', 'byteLength', 'contentType', 'path']) {
      const mutated = assets.map((asset, index) =>
        index === 0 ? { ...asset, [field]: field === 'byteLength' ? 4 : `${asset[field]}x` } : asset
      )
      expect(computeMobileWebBundleBuildId(mutated)).not.toBe(baseline)
    }
  })
})

describe('hashedAsset', () => {
  it('names an asset by its own digest, which is what makes the tree content-addressed', () => {
    const asset = hashedAsset(Buffer.from('body', 'utf8'), 'js')

    expect(asset.path).toBe(`assets/${asset.sha256}.js`)
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(asset.byteLength).toBe(4)
    expect(asset.contentType).toBe(contentTypeForExtension('js'))
  })

  it('refuses an extension with no registered content type', () => {
    // A type the phone has no rule for would otherwise reach the manifest and be served as
    // whatever the shell guessed, which is the one thing a content-addressed tree cannot allow.
    expect(() => hashedAsset(Buffer.from('body'), 'wasm')).toThrow(/no content type registered/)
  })
})

describe('writeMobileWebBundleTree', () => {
  it('stamps the page version the contract names, which the shell floors on', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'mobile-web-bundle-manifest-'))
    try {
      const bytes = Buffer.from('<!doctype html>\n', 'utf8')
      const entry = {
        path: 'index.html',
        bytes,
        sha256: sha256Hex(bytes),
        byteLength: bytes.byteLength,
        contentType: contentTypeForExtension('html')
      }
      await writeMobileWebBundleTree({
        outDir,
        written: [entry],
        desktopVersion: '1.0.0',
        protocolWindow: { runtimeProtocolVersion: 3, minCompatibleRuntimeProtocolVersion: 3 }
      })
      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'))
      expect(Number.isInteger(manifest.pageVersion)).toBe(true)
      expect(MobileWebBundleManifestSchema.parse(manifest).pageVersion).toBe(manifest.pageVersion)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
