import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { readPackage } = createRequire(import.meta.url)('../../../packaged-runtime-node-modules.cjs')

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value))
}

describe('readPackage', () => {
  let fixtureDir

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('climbs past a nested dist/cjs marker when exports maps ./* onto dist/cjs', () => {
    fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-package-root-')))
    const nodeModulesDir = join(fixtureDir, 'node_modules')
    const packageDir = join(nodeModulesDir, 'nested-marker')
    const consumerDir = join(nodeModulesDir, 'consumer')
    mkdirSync(join(packageDir, 'dist', 'cjs'), { recursive: true })
    mkdirSync(consumerDir)
    writeJson(join(packageDir, 'package.json'), {
      name: 'nested-marker',
      exports: { '.': { require: './dist/cjs/index.js' }, './*': { require: './dist/cjs/*' } },
      dependencies: { dep: '1.0.0' }
    })
    writeJson(join(packageDir, 'dist', 'cjs', 'package.json'), { type: 'commonjs' })
    writeFileSync(join(packageDir, 'dist', 'cjs', 'index.js'), 'module.exports = {}\n')
    writeJson(join(consumerDir, 'package.json'), { name: 'consumer' })

    expect(readPackage('nested-marker', consumerDir)).toEqual({
      name: 'nested-marker',
      packageDir,
      dependencies: ['dep']
    })
  })
})
