import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../src/shared/windows-transient-lock-removal.ts'
import {
  runPackagedProcessHostConsumer,
  stagePackagedProcessHost,
  writePackagedProcessHostConsumer
} from './packaged-process-host-fixture.mjs'

const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')
const { collectRuntimeClosure } = require('./verify-skills-cli-runtime.cjs')
const nodeExecutable = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath

it('loads the copied process package from an unpacked CLI without checkout dependencies', async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-process-host-'))
  try {
    const resource = createPackagedRuntimeNodeModuleResources().find(
      (entry) => entry.to === join('node_modules', '@orca', 'process-host')
    )
    expect(resource).toBeDefined()
    expect(resource.filter).toEqual(['package.json', 'dist/**/*'])
    const packageDir = await stagePackagedProcessHost(resourcesDir)
    expect(existsSync(join(packageDir, 'src'))).toBe(false)

    const { outDir, entry } = await writePackagedProcessHostConsumer(resourcesDir)
    const closure = collectRuntimeClosure(outDir, resourcesDir)
    expect(closure).toContain(realpathSync(join(packageDir, 'dist', 'run-process.js')))
    const result = runPackagedProcessHostConsumer(nodeExecutable, resourcesDir, entry)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('copied-runtime')
  } finally {
    await removeTree(resourcesDir)
  }
})

describe('process-host output packaging guard', () => {
  const { assertProcessHostOutputBuilt } = require('../packaged-runtime-node-modules.cjs')
  const electronBuilderConfig = require('../electron-builder.config.cjs')

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

  it('accepts the checkout package', () => {
    expect(() => assertProcessHostOutputBuilt()).not.toThrow()
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

  it('runs in beforePack', () => {
    expect(String(electronBuilderConfig.beforePack)).toContain('assertProcessHostOutputBuilt()')
  })
})
