import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const electronBuilderNativeRebuild = require('./electron-builder-native-rebuild.cjs')
const { findAsarEntry, verifyPackagedMainRuntimeDeps } = require('../packaged-runtime-node-modules.cjs')

describe('electron-builder config', () => {
  it('uses the multi-size icon source for Linux packages', () => {
    expect(electronBuilderConfig.linux.icon).toBe('resources/build/icon.icns')
  })

  it('builds RPMs without changing existing Linux artifact names', () => {
    expect(electronBuilderConfig.linux.target).toEqual(['AppImage', 'deb', 'rpm'])
    expect(electronBuilderConfig.appImage.artifactName).toBe('orca-linux.${ext}')
    expect(electronBuilderConfig.deb.artifactName).toBe('orca-ide_${version}_${arch}.${ext}')
    expect(electronBuilderConfig.rpm).toMatchObject({
      packageName: 'orca-ide',
      artifactName: 'orca-ide-${version}.${arch}.${ext}'
    })
  })

  it('uses Orca native rebuild hook instead of electron-builder default rebuild', () => {
    expect(electronBuilderConfig.beforeBuild).toBe(electronBuilderNativeRebuild)
    expect(electronBuilderConfig.npmRebuild).toBe(true)
  })

  it('verifies packaged main runtime deps from Windows-style asar entries', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-deps-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')
      await mkdir(join(resourcesDir, 'node_modules', 'yaml'), { recursive: true })
      await mkdir(join(resourcesDir, 'node_modules', 'zod'), { recursive: true })

      const sources = new Map([
        ['out\\main\\index.js', 'const z = require("zod")'],
        [
          'out\\main\\agent-hooks\\managed-agent-hook-controls.js',
          'const YAML = require("yaml")'
        ]
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `\\${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('normalizes host-specific asar entry separators', () => {
    expect(findAsarEntry(['\\out\\main\\index.js'], 'out/main/index.js')).toBe(
      '\\out\\main\\index.js'
    )
    expect(findAsarEntry(['/out/main/index.js'], 'out/main/index.js')).toBe('/out/main/index.js')
  })
})
