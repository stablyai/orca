import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMobileWebBundle } from './build-mobile-web-bundle.mjs'

const require = createRequire(import.meta.url)
const { assertMobileWebBundleBuilt } = require('./verify-packaged-mobile-web-bundle.cjs')
const electronBuilderConfig = require('../electron-builder.config.cjs')

async function withBundle(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-guard-'))
  const bundleDir = join(scratch, 'mobile-web')
  try {
    const { manifest } = await buildMobileWebBundle({ outDir: bundleDir })
    await run({ bundleDir, manifest })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function rewriteManifest(bundleDir, mutate) {
  const manifestPath = join(bundleDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  mutate(manifest)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
}

describe('assertMobileWebBundleBuilt', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a freshly built bundle', async () => {
    await withBundle(({ bundleDir, manifest }) => {
      expect(() => assertMobileWebBundleBuilt(bundleDir)).not.toThrow()
      expect(manifest.entrypoint).toBe('index.html')
      expect(manifest.assets.length).toBeGreaterThanOrEqual(3)
      expect(
        new Set(manifest.assets.map((asset) => asset.contentType)).size
      ).toBeGreaterThanOrEqual(2)
    })
  })

  it('fails when the manifest is missing', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-guard-'))
    try {
      expect(() => assertMobileWebBundleBuilt(scratch)).toThrow(/no bundle manifest/)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('fails when the manifest is not JSON', async () => {
    await withBundle(async ({ bundleDir }) => {
      await writeFile(join(bundleDir, 'manifest.json'), 'not json', 'utf8')
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/not valid JSON/)
    })
  })

  it('fails when an asset is tampered with on disk', async () => {
    await withBundle(async ({ bundleDir, manifest }) => {
      const asset = manifest.assets.find((entry) => entry.path.endsWith('.js'))
      const bytes = await readFile(join(bundleDir, asset.path))
      // Same length, different content: only the hash check can catch this.
      bytes[bytes.length - 1] = bytes.at(-1) === 0x20 ? 0x09 : 0x20
      await writeFile(join(bundleDir, asset.path), bytes)
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/hashes to .* on disk/)
    })
  })

  it('fails when an asset is truncated', async () => {
    await withBundle(async ({ bundleDir, manifest }) => {
      const asset = manifest.assets.find((entry) => entry.path.endsWith('.css'))
      await writeFile(join(bundleDir, asset.path), 'truncated', 'utf8')
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/bytes on disk, manifest says/)
    })
  })

  it('fails when a listed asset was never written', async () => {
    await withBundle(async ({ bundleDir, manifest }) => {
      const asset = manifest.assets.find((entry) => entry.path.endsWith('.png'))
      await rm(join(bundleDir, asset.path))
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/which is missing from/)
    })
  })

  it('fails when the manifest buildId no longer matches its asset list', async () => {
    await withBundle(async ({ bundleDir }) => {
      await rewriteManifest(bundleDir, (manifest) => {
        manifest.buildId = 'f'.repeat(64)
      })
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/does not match its asset list/)
    })
  })

  it('fails on an unknown schemaVersion', async () => {
    await withBundle(async ({ bundleDir }) => {
      await rewriteManifest(bundleDir, (manifest) => {
        manifest.schemaVersion = 2
      })
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(
        /unsupported manifest schemaVersion/
      )
    })
  })

  it('fails when a required field is dropped', async () => {
    await withBundle(async ({ bundleDir }) => {
      await rewriteManifest(bundleDir, (manifest) => {
        delete manifest.desktopVersion
      })
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/desktopVersion is missing/)
    })
  })

  it('fails when totalBytes disagrees with the asset list', async () => {
    await withBundle(async ({ bundleDir }) => {
      await rewriteManifest(bundleDir, (manifest) => {
        manifest.totalBytes += 1
      })
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/its assets sum to/)
    })
  })

  it('refuses an asset path that escapes the bundle directory', async () => {
    await withBundle(async ({ bundleDir }) => {
      await rewriteManifest(bundleDir, (manifest) => {
        manifest.assets[0].path = '../outside.js'
      })
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/not a safe relative path/)
    })
  })

  it('refuses a manifest whose entrypoint is not one of its assets', async () => {
    await withBundle(async ({ bundleDir }) => {
      await rewriteManifest(bundleDir, (manifest) => {
        manifest.entrypoint = 'index.html'
        manifest.assets = manifest.assets.filter((asset) => asset.path !== 'index.html')
      })
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/is not one of its assets/)
    })
  })
})

describe('electron-builder packaging wiring', () => {
  it('excludes the mobile-web source tree from app.asar', () => {
    expect(electronBuilderConfig.files).toContain('!mobile-web{,/**/*}')
  })

  it('does not exclude the built bundle, so out/mobile-web ships like out/web', () => {
    const excludesBuiltBundle = electronBuilderConfig.files.some(
      (entry) => typeof entry === 'string' && entry.startsWith('!out/mobile-web')
    )
    expect(excludesBuiltBundle).toBe(false)
  })

  it('runs the bundle guard in beforePack', () => {
    expect(String(electronBuilderConfig.beforePack)).toContain('assertMobileWebBundleBuilt')
  })
})
