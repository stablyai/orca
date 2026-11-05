import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../../../src/shared/windows-transient-lock-removal.ts'

const require = createRequire(import.meta.url)

describe('process-host output packaging guard', () => {
  const { assertProcessHostOutputBuilt } = require('../../../packaged-runtime-node-modules.cjs')

  async function builtPackage() {
    const packageDir = await mkdtemp(join(tmpdir(), 'orca-process-host-output-'))
    await mkdir(join(packageDir, 'src', '__fixtures__'), { recursive: true })
    await mkdir(join(packageDir, 'dist'))
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        main: './dist/entry.js',
        exports: {
          '.': { types: './dist/entry.d.ts', default: './dist/entry.js' },
          './feature': { default: './dist/feature.js' }
        }
      })
    )
    for (const module of ['entry', 'feature', 'internal']) {
      await writeFile(join(packageDir, 'src', `${module}.ts`), '')
      await writeFile(join(packageDir, 'dist', `${module}.js`), '')
    }
    await writeFile(join(packageDir, 'src', 'entry.test.ts'), '')
    await writeFile(join(packageDir, 'src', '__fixtures__', 'child.ts'), '')
    return packageDir
  }

  it('accepts complete output and ignores test and fixture sources', async () => {
    const packageDir = await builtPackage()
    try {
      expect(() => assertProcessHostOutputBuilt(packageDir)).not.toThrow()
    } finally {
      await removeTree(packageDir)
    }
  })

  it.each([
    ['a public export target', 'feature.js', /missing: \.\/dist\/feature\.js/],
    ['an internal module', 'internal.js', /missing: \.\/dist\/internal\.js/]
  ])('fails when %s was never emitted', async (_label, file, message) => {
    const packageDir = await builtPackage()
    try {
      await rm(join(packageDir, 'dist', file))
      expect(() => assertProcessHostOutputBuilt(packageDir)).toThrow(message)
    } finally {
      await removeTree(packageDir)
    }
  })

  it('fails when dist is absent', async () => {
    const packageDir = await builtPackage()
    try {
      await rm(join(packageDir, 'dist'), { recursive: true })
      expect(() => assertProcessHostOutputBuilt(packageDir)).toThrow(/pnpm build:packages/)
    } finally {
      await removeTree(packageDir)
    }
  })

  it('fails when dist still holds output of a removed source', async () => {
    const packageDir = await builtPackage()
    try {
      await writeFile(join(packageDir, 'dist', 'renamed-away.js'), '')
      expect(() => assertProcessHostOutputBuilt(packageDir)).toThrow(
        /stale: \.\/dist\/renamed-away\.js/
      )
    } finally {
      await removeTree(packageDir)
    }
  })
})
