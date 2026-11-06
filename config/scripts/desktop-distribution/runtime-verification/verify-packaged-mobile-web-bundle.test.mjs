import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeMobileWebBundleFixtureTree } from '../../build/mobile-web-app/mobile-web-bundle-fixture-tree.mjs'

const require = createRequire(import.meta.url)
const { assertMobileWebBundleBuilt } = require('./verify-packaged-mobile-web-bundle.cjs')
const electronBuilderConfig = require('../../../electron-builder.config.cjs')
const { darkBuildMarkers } = require('../../../dark-build-switches.cjs')

async function withBundle(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-guard-'))
  const bundleDir = join(scratch, 'mobile-web')
  try {
    const { manifest } = await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
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

  it('fails on a file the manifest does not list, so no stale asset ships inside asar', async () => {
    await withBundle(async ({ bundleDir }) => {
      // Dropped content-addressed assets never overwrite themselves; reject leftovers rather than pack unverified unreachable bytes.
      await writeFile(join(bundleDir, 'assets', 'stale.js'), '// from an earlier build\n', 'utf8')
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(
        /does not list: assets\/stale\.js/
      )
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

  it('fails when a listed asset was never written', async () => {
    await withBundle(async ({ bundleDir, manifest }) => {
      const asset = manifest.assets.find((entry) => entry.path.endsWith('.png'))
      await rm(join(bundleDir, asset.path))
      expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(/which is missing from/)
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
})

describe('electron-builder packaging wiring', () => {
  it('verifies a dark page build, and refuses to package it', async () => {
    await withBundle(async ({ bundleDir }) => {
      const [marker] = darkBuildMarkers({ ORCA_SIDEBAR_INPUTS: 'main' })
      await writeFile(join(bundleDir, marker.fileName), marker.text, 'utf8')
      expect(() => assertMobileWebBundleBuilt(bundleDir)).not.toThrow()
      expect(() =>
        electronBuilderConfig.beforePack(
          { electronPlatformName: process.platform, arch: process.arch === 'arm64' ? 3 : 1 },
          bundleDir
        )
      ).toThrow(`${bundleDir} holds an ORCA_SIDEBAR_INPUTS=main build`)
    })
  })
})
