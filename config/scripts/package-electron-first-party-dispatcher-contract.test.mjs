import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')
const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))

describe('packaged first-party dispatcher contract', () => {
  it('includes the scoped first-party HTTP dispatcher in every packaged runtime', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const packagedTargets = createPackagedRuntimeNodeModuleResources(platform).map(
        (resource) => resource.to
      )
      expect(packagedTargets).toContain(join('node_modules', 'undici'))
    }
  })

  it('keeps Windows certificate enumeration optional and platform-gated', () => {
    const rebuildScript = readFileSync(
      join(projectDir, 'config/scripts/rebuild-native-deps.mjs'),
      'utf8'
    )
    const ensureScript = readFileSync(
      join(projectDir, 'config/scripts/ensure-native-runtime.mjs'),
      'utf8'
    )
    expect(packageJson.optionalDependencies['win-export-certificate-and-key']).toBe('3.0.2')
    expect(packageJson.pnpm.onlyBuiltDependencies).not.toContain('win-export-certificate-and-key')
    expect(rebuildScript).toContain("'win-export-certificate-and-key'")
    expect(rebuildScript).toContain('Continuing postinstall')
    expect(ensureScript).not.toContain('win-export-certificate-and-key')
    const packageTargets = {
      win32: createPackagedRuntimeNodeModuleResources('win32'),
      darwin: createPackagedRuntimeNodeModuleResources('darwin'),
      linux: createPackagedRuntimeNodeModuleResources('linux')
    }
    expect(packageTargets.win32).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: join('node_modules', 'win-export-certificate-and-key') })
      ])
    )
    for (const platform of ['darwin', 'linux']) {
      expect(packageTargets[platform]).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', 'win-export-certificate-and-key') })
        ])
      )
    }
  })
})
