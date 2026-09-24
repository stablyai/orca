import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'

const fixtureDir = mkdtempSync(join(tmpdir(), 'script-module-dependencies-'))

function sourceTree(files) {
  const sourceDir = mkdtempSync(join(fixtureDir, 'source-'))
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(sourceDir, name), contents)
  }
  return sourceDir
}

function copiedNames(files, entryName) {
  const sourceDir = sourceTree(files)
  const destinationDir = join(mkdtempSync(join(fixtureDir, 'dest-')), 'scripts')
  copyScriptWithLocalModules(join(sourceDir, entryName), destinationDir)
  return readdirSync(destinationDir).sort()
}

describe('copyScriptWithLocalModules', () => {
  it('takes the entry script itself', () => {
    expect(copiedNames({ 'entry.mjs': 'export const a = 1\n' }, 'entry.mjs')).toEqual(['entry.mjs'])
  })

  it('follows a co-located import', () => {
    expect(
      copiedNames(
        { 'entry.mjs': "import { a } from './dep.mjs'\n", 'dep.mjs': 'export const a = 1\n' },
        'entry.mjs'
      )
    ).toEqual(['dep.mjs', 'entry.mjs'])
  })

  // The Windows addon gates are .cjs and reach each other by require. A module
  // pulled in only that way used to be left behind, and the subprocess then
  // failed with a resolution error that looks nothing like the defect it hides.
  it('follows a co-located require, not only an import', () => {
    expect(
      copiedNames(
        {
          'entry.cjs': "const { a } = require('./dep.cjs')\nmodule.exports = { a }\n",
          'dep.cjs': 'module.exports = { a: 1 }\n'
        },
        'entry.cjs'
      )
    ).toEqual(['dep.cjs', 'entry.cjs'])
  })

  it('follows a require reached only through an imported module', () => {
    const names = copiedNames(
      {
        'entry.mjs': "import './middle.cjs'\n",
        'middle.cjs': "require('./leaf.cjs')\n",
        'leaf.cjs': 'module.exports = {}\n'
      },
      'entry.mjs'
    )
    expect(names).toContain('leaf.cjs')
  })

  it('leaves package and builtin specifiers alone', () => {
    const sourceDir = sourceTree({
      'entry.mjs': "import { join } from 'node:path'\nimport x from 'some-package'\n"
    })
    const destinationDir = join(mkdtempSync(join(fixtureDir, 'dest-')), 'scripts')
    copyScriptWithLocalModules(join(sourceDir, 'entry.mjs'), destinationDir)
    expect(readdirSync(destinationDir)).toEqual(['entry.mjs'])
  })

  it('terminates on a cycle rather than recursing forever', () => {
    expect(
      copiedNames({ 'a.mjs': "import './b.mjs'\n", 'b.mjs': "import './a.mjs'\n" }, 'a.mjs')
    ).toEqual(['a.mjs', 'b.mjs'])
  })

  it('creates the destination directory it was handed', () => {
    const sourceDir = sourceTree({ 'entry.mjs': 'export const a = 1\n' })
    const destinationDir = join(mkdtempSync(join(fixtureDir, 'dest-')), 'nested', 'scripts')
    copyScriptWithLocalModules(join(sourceDir, 'entry.mjs'), destinationDir)
    expect(existsSync(join(destinationDir, 'entry.mjs'))).toBe(true)
  })

  // The real tree this stages: the packaged-addon gate reaches its PE reader by
  // require, so a walker that missed it would break every rebuild fixture.
  it('stages the node-pty job-ownership gate with everything it requires', () => {
    const destinationDir = join(mkdtempSync(join(fixtureDir, 'dest-')), 'scripts')
    copyScriptWithLocalModules(
      fileURLToPath(new URL('./node-pty-job-ownership.cjs', import.meta.url)),
      destinationDir
    )
    expect(readdirSync(destinationDir).sort()).toEqual([
      'node-pty-job-ownership.cjs',
      'windows-pe-machine.cjs'
    ])
  })
})
