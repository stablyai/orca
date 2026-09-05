import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')

describe('packaged Session History FTS runtime', () => {
  it('copies fts5-sql-bundle into packaged runtime node_modules', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(createPackagedRuntimeNodeModuleResources(platform)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', 'fts5-sql-bundle') })
        ])
      )
    }
  })
})
