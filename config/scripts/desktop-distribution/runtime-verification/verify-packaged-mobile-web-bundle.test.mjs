import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeMobileWebBundleFixtureTree } from '../../build/mobile-web-app/mobile-web-bundle-fixture-tree.mjs'

const require = createRequire(import.meta.url)
const { assertMobileWebBundleBuilt } = require('./verify-packaged-mobile-web-bundle.cjs')

async function withBundle(run, { brotli = false } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-guard-'))
  const bundleDir = join(scratch, 'mobile-web')
  try {
    const { manifest } = await writeMobileWebBundleFixtureTree({ outDir: bundleDir, brotli })
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

  it('accepts the brotli copies the manifest lists, and fails one that inflates to other bytes', async () => {
    await withBundle(
      async ({ bundleDir, manifest }) => {
        const asset = manifest.assets.find((entry) => entry.brotliByteLength !== undefined)
        expect(() => assertMobileWebBundleBuilt(bundleDir)).not.toThrow()
        const forged = brotliCompressSync(Buffer.from('not the asset'))
        await writeFile(join(bundleDir, `${asset.path}.br`), forged)
        await rewriteManifest(bundleDir, (rewritten) => {
          rewritten.assets.find((entry) => entry.path === asset.path).brotliByteLength =
            forged.byteLength
        })
        expect(() => assertMobileWebBundleBuilt(bundleDir)).toThrow(
          `${asset.path}.br does not inflate to ${asset.path}`
        )
      },
      { brotli: true }
    )
  })
})
