import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

function dependencyRequire(packages) {
  let require = createRequire(import.meta.url)
  for (const name of packages) {
    require = createRequire(require.resolve(name))
  }
  return require
}

// Resolve through declared consumers so hoisting cannot select another workspace's copy.
const sprintfRequire = dependencyRequire([
  'electron-builder',
  'app-builder-lib',
  '@electron/get',
  'global-agent',
  'roarr'
])
const globRequire = dependencyRequire(['i18next-cli'])
const minimatchCopies = [
  ['9.0.9', dependencyRequire(['electron-builder', 'app-builder-lib', '@electron/universal'])],
  ['10.2.5', dependencyRequire(['i18next-cli', 'glob'])],
  ['10.2.6', dependencyRequire(['electron-builder', 'app-builder-lib'])]
]
const tempDirs = []

function makeTree(dir, depth) {
  fs.writeFileSync(join(dir, 'f'), '')
  for (const child of depth ? ['a', 'b'] : []) {
    fs.mkdirSync(join(dir, child))
    makeTree(join(dir, child), depth - 1)
  }
}

describe('installed dependency security patches', () => {
  it.each(['src/sprintf.js', 'dist/sprintf.min.js'])('bounds numeric precision in %s', (entry) => {
    const { sprintf } = sprintfRequire(`sprintf-js/${entry}`)
    for (const type of ['e', 'f', 'g']) {
      expect(() => sprintf(`%.${'9'.repeat(500)}${type}`, 1.234)).not.toThrow()
      expect(sprintf(`%.${'9'.repeat(500)}${type}`, 1.234).length).toBeLessThan(110)
    }
    expect(sprintf('%.2f', 1.234)).toBe('1.23')
    expect(sprintf('%.2e', 1.234)).toBe('1.23e+0')
    expect(sprintf('%.2g', 1.234)).toBe('1.2')
    expect(sprintf('%.3s', 'abcdef')).toBe('abc')
    expect(sprintf('%.0f', 1.7)).toBe('2')
    expect(sprintf('%.0e', 1.7)).toBe('2e+0')
  })

  it.each(minimatchCopies)('bounds **/.. pattern splitting in minimatch %s', (version, require) => {
    const { Minimatch } = require('minimatch')
    expect(require('minimatch/package.json').version).toBe(version)
    const amplified = Array(10).fill('**/../a/b').join('/')
    expect(new Minimatch(amplified, { optimizationLevel: 2, braceExpandMax: 64 }).set).toHaveLength(
      64
    )
    const mm = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 })
    expect(mm.set).toHaveLength(4)
    expect(mm.match('x/a/b/y/c/d')).toBe(true)
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops glob 13 directory reads after an abort', async () => {
    const { glob } = globRequire('glob')
    expect(globRequire('glob/package.json').version).toBe('13.0.6')
    const cwd = mkdtempSync(join(tmpdir(), 'orca-glob-abort-'))
    tempDirs.push(cwd)
    makeTree(cwd, 5)
    const controller = new AbortController()
    let reads = 0
    // Settles after the latest read's callback has run, so follow-up reads are already counted.
    let lastRead = Promise.resolve()
    const countedFs = {
      ...fs,
      readdir: (...args) => {
        if (++reads === 1) {
          controller.abort(new Error('stop'))
        }
        const callback = args.pop()
        let settle = () => {}
        lastRead = new Promise((resolve) => {
          settle = resolve
        })
        fs.readdir(...args, (...result) => {
          callback(...result)
          settle()
        })
      }
    }
    await expect(glob('**', { cwd, signal: controller.signal, fs: countedFs })).rejects.toThrow(
      'stop'
    )
    await lastRead
    expect(reads).toBe(1)
    expect(await glob('**/f', { cwd })).toHaveLength(63)
  })
})
