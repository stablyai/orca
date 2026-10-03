import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const {
  PACKAGED_RUNTIME_PACKAGE_ROOTS,
  createPackagedRuntimeNodeModuleResources
} = require('../packaged-runtime-node-modules.cjs')

const windowsAddonsInstalled = existsSync(
  join(projectDir, 'node_modules', '@vscode', 'windows-process-tree', 'package.json')
)

describe('packaged Session History FTS runtime', () => {
  it('copies fts5-sql-bundle into packaged runtime node_modules', () => {
    expect(PACKAGED_RUNTIME_PACKAGE_ROOTS).toContain('fts5-sql-bundle')
    const platforms = windowsAddonsInstalled ? ['win32', 'darwin', 'linux'] : ['darwin', 'linux']
    for (const platform of platforms) {
      expect(createPackagedRuntimeNodeModuleResources(platform)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', 'fts5-sql-bundle') })
        ])
      )
    }
  })
})
