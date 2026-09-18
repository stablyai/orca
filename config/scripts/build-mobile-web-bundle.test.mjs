import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildMobileWebBundle,
  computeMobileWebBundleBuildId,
  serializeMobileWebBundleAssets
} from './build-mobile-web-bundle.mjs'
import {
  MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS,
  MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES
} from './verify-mobile-web-bundle.mjs'

async function buildIntoScratch() {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-build-'))
  const bundleDir = join(scratch, 'mobile-web')
  const { manifest } = await buildMobileWebBundle({ outDir: bundleDir })
  return { scratch, bundleDir, manifest }
}

describe('buildMobileWebBundle', () => {
  it('emits a content-addressed bundle whose only stable name is the entrypoint', async () => {
    const { scratch, bundleDir, manifest } = await buildIntoScratch()
    try {
      const root = await readdir(bundleDir)
      expect(root.sort()).toEqual(['assets', 'index.html', 'manifest.json'])
      for (const name of await readdir(join(bundleDir, 'assets'))) {
        const [digest, extension] = name.split('.')
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
        const bytes = await readFile(join(bundleDir, 'assets', name))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest)
        expect(extension).toMatch(/^(js|css|png)$/)
      }
      const html = await readFile(join(bundleDir, 'index.html'), 'utf8')
      for (const asset of manifest.assets) {
        if (asset.path !== 'index.html') {
          expect(html).toContain(asset.path)
        }
      }
      expect(html).not.toContain('__ORCA_')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('carries every manifest field the Phase A contract names', async () => {
    const { scratch, manifest } = await buildIntoScratch()
    try {
      expect(Object.keys(manifest)).toEqual([
        'schemaVersion',
        'buildId',
        'desktopVersion',
        'minCompatibleRuntimeProtocolVersion',
        'runtimeProtocolVersion',
        'entrypoint',
        'totalBytes',
        'assets'
      ])
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.entrypoint).toBe('index.html')
      const packageJson = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8')
      )
      expect(manifest.desktopVersion).toBe(packageJson.version)
      const protocolSource = await readFile(
        new URL('../../src/shared/protocol-version.ts', import.meta.url),
        'utf8'
      )
      expect(protocolSource).toContain(
        `export const RUNTIME_PROTOCOL_VERSION = ${String(manifest.runtimeProtocolVersion)}`
      )
      expect(protocolSource).toContain(
        `export const MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = ${String(manifest.minCompatibleRuntimeProtocolVersion)}`
      )
      expect(manifest.totalBytes).toBe(
        manifest.assets.reduce((total, asset) => total + asset.byteLength, 0)
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('produces the same buildId from two independent builds', async () => {
    const first = await buildIntoScratch()
    const second = await buildIntoScratch()
    try {
      expect(second.manifest.buildId).toBe(first.manifest.buildId)
      expect(second.manifest).toEqual(first.manifest)
    } finally {
      await rm(first.scratch, { recursive: true, force: true })
      await rm(second.scratch, { recursive: true, force: true })
    }
  })

  it('embeds no absolute path from the machine that built it', async () => {
    const { scratch, bundleDir } = await buildIntoScratch()
    try {
      const names = [
        'index.html',
        'manifest.json',
        ...(await readdir(join(bundleDir, 'assets'))).map((name) => join('assets', name))
      ]
      for (const name of names) {
        const text = (await readFile(join(bundleDir, name))).toString('latin1')
        expect(text).not.toContain(scratch)
        expect(text).not.toContain(process.cwd())
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('stays inside the Phase A budget', async () => {
    const { scratch, manifest } = await buildIntoScratch()
    try {
      expect(manifest.assets.length).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS)
      expect(manifest.totalBytes).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

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
