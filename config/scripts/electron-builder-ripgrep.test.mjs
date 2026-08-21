import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { prunePackagedRipgrep } = require('../packaged-runtime-node-modules.cjs')

const RIPGREP_PLATFORM_PACKAGES = [
  'ripgrep-darwin-arm64',
  'ripgrep-darwin-x64',
  'ripgrep-linux-arm64',
  'ripgrep-linux-x64',
  'ripgrep-win32-arm64',
  'ripgrep-win32-x64'
]

describe('bundled ripgrep packaging', () => {
  // Why: rg is spawned as an executable, and a binary inside app.asar cannot be exec'd —
  // packing it would silently drop Quick Open back to the git fallback (#9539).
  it('unpacks the bundled ripgrep binaries', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining(['node_modules/@vscode/ripgrep-*/**'])
    )
  })

  it('prunes non-target ripgrep platform subpackages from app.asar.unpacked', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-ripgrep-prune-'))
    try {
      const vscodeDir = join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@vscode')
      await mkdir(join(vscodeDir, 'ripgrep'), { recursive: true })
      for (const name of RIPGREP_PLATFORM_PACKAGES) {
        await mkdir(join(vscodeDir, name), { recursive: true })
      }

      prunePackagedRipgrep(resourcesDir, 'darwin', 'arm64')

      await expect(readdir(vscodeDir).then((entries) => entries.sort())).resolves.toEqual([
        'ripgrep',
        'ripgrep-darwin-arm64'
      ])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  // Why: electron-builder's ${platform} macro expands to the build host, not the target,
  // so a cross-built artifact must be pruned from context.electronPlatformName instead.
  it('prunes by the target platform, not the build host', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-ripgrep-prune-cross-'))
    try {
      const vscodeDir = join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@vscode')
      for (const name of RIPGREP_PLATFORM_PACKAGES) {
        await mkdir(join(vscodeDir, name), { recursive: true })
      }

      prunePackagedRipgrep(resourcesDir, 'win32', 'x64')

      await expect(readdir(vscodeDir)).resolves.toEqual(['ripgrep-win32-x64'])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported packaging architecture', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-ripgrep-prune-arch-'))
    try {
      await mkdir(join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@vscode'), {
        recursive: true
      })
      expect(() => prunePackagedRipgrep(resourcesDir, 'darwin', 'universal')).toThrow(
        'Unsupported packaged runtime architecture: universal'
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })
})
