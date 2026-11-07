import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'

const fixtureDir = mkdtempSync(join(tmpdir(), 'script-module-dependencies-'))

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

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
  const names = readdirSync(destinationDir).sort()
  for (const name of names) {
    expect(readFileSync(join(destinationDir, name), 'utf8'), name).toBe(files[name])
  }
  return names
}

describe('copyScriptWithLocalModules', () => {
  it('preserves parent paths for modules shared with the runtime', () => {
    const sourceDir = sourceTree({ 'runtime.ts': 'export const value = 42\n' })
    mkdirSync(join(sourceDir, 'scripts'))
    writeFileSync(
      join(sourceDir, 'scripts', 'entry.mjs'),
      "export { value } from '../runtime.ts'\n"
    )
    const destinationRoot = mkdtempSync(join(fixtureDir, 'dest-'))
    copyScriptWithLocalModules(
      join(sourceDir, 'scripts', 'entry.mjs'),
      join(destinationRoot, 'scripts')
    )
    expect(readFileSync(join(destinationRoot, 'runtime.ts'), 'utf8')).toBe(
      'export const value = 42\n'
    )
  })

  // Cover require-only CJS gate dependencies so copied fixture fails for target defect, not missing module.

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

  it('copies file-URL assets without interpreting their contents as module imports', () => {
    expect(
      copiedNames(
        {
          'entry.mjs': "import './patch.mjs'\n",
          'patch.mjs': "new URL('./deadline.rs', import.meta.url)\n",
          'deadline.rs': "use crate::Connection;\n// import './not-a-module.mjs'\n"
        },
        'entry.mjs'
      )
    ).toEqual(['deadline.rs', 'entry.mjs', 'patch.mjs'])
  })

  it('terminates on a cycle rather than recursing forever', () => {
    expect(
      copiedNames({ 'a.mjs': "import './b.mjs'\n", 'b.mjs': "import './a.mjs'\n" }, 'a.mjs')
    ).toEqual(['a.mjs', 'b.mjs'])
  })
})
