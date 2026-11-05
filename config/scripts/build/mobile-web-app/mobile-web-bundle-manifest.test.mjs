import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contentTypeForExtension,
  hashedAsset,
  sha256Hex,
  writeMobileWebBundleTree
} from './mobile-web-bundle-manifest.mjs'

describe('hashedAsset', () => {
  it('refuses an extension with no registered content type', () => {
    // Unknown content type must fail rather than leave phone guessing how to serve addressed bytes.
    expect(() => hashedAsset(Buffer.from('body'), 'wasm')).toThrow(/no content type registered/)
  })
})

describe('writeMobileWebBundleTree', () => {
  it('marks a dark build outside the manifest, so its buildId is the same tree’s', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'mobile-web-bundle-manifest-'))
    try {
      const bytes = Buffer.from('<!doctype html>\n', 'utf8')
      const tree = (env) =>
        writeMobileWebBundleTree({
          outDir,
          written: [
            {
              path: 'index.html',
              bytes,
              sha256: sha256Hex(bytes),
              byteLength: bytes.byteLength,
              contentType: contentTypeForExtension('html')
            }
          ],
          desktopVersion: '1.0.0',
          protocolWindow: { runtimeProtocolVersion: 3, minCompatibleRuntimeProtocolVersion: 3 },
          env
        })
      const dark = await tree({ ORCA_SIDEBAR_INPUTS: 'main' })
      expect(existsSync(join(outDir, 'ORCA_SIDEBAR_INPUTS_MAIN'))).toBe(true)
      const off = await tree({})
      expect(existsSync(join(outDir, 'ORCA_SIDEBAR_INPUTS_MAIN'))).toBe(false)
      expect(dark.manifest.buildId).toBe(off.manifest.buildId)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
