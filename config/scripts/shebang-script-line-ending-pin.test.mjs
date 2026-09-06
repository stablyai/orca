import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the `.gitattributes` pin that keeps `config/scripts` scripts on LF.
 *
 * `core.autocrlf=true` ships in the Git-for-Windows system config, so without a
 * pin a Windows checkout gets CRLF. Vite's SSR transform locates the shebang
 * with `/^#!.*\n/` — `\r` is a JS regex line terminator, so `.` never matches it
 * and the pattern misses on CRLF. The hoisted import/export preamble then lands
 * at offset 0, ahead of the shebang, which in turn defeats the `code[0] === '#'`
 * guard that blanks it. A literal `#!` survives into the middle of the module and
 * every suite importing the script dies at load with a SyntaxError.
 *
 * Scoped to `config/scripts` because that is where tests import scripts. Other
 * shebanged `.mjs` in the tree are spawned, not imported, so they cannot hit this.
 */
const projectDir = resolve(import.meta.dirname, '../..')
const SCRIPT_DIRECTORY = 'config/scripts'

function git(args) {
  return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' })
}

/** `git check-attr -z` emits NUL-separated path/attr/value triples. */
function eolAttributes(paths) {
  const fields = git(['check-attr', '-z', 'eol', '--', ...paths]).split('\0')
  const found = new Map()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    found.set(fields[index], fields[index + 2])
  }
  return found
}

function shebangScripts() {
  return git(['ls-files', '-z', '--', `${SCRIPT_DIRECTORY}/*.mjs`])
    .split('\0')
    .filter(Boolean)
    .filter((path) => readFileSync(join(projectDir, path), 'utf8').startsWith('#!'))
}

describe('config/scripts line-ending pin', () => {
  it('pins every shebanged script to LF', () => {
    const scripts = shebangScripts()
    expect(scripts.length).toBeGreaterThan(0)

    const attributes = eolAttributes(scripts)
    const unpinned = scripts.filter((path) => attributes.get(path) !== 'lf')

    expect(
      unpinned,
      'A shebanged script left on the platform default gets CRLF on Windows, ' +
        'which makes every suite importing it fail to load. Pin it in .gitattributes.'
    ).toEqual([])
  })

  // Why: without these the assertion above still passes against a pattern so broad
  // it says nothing, or so narrow it only covers the files that exist today.
  it.each([
    ['config/scripts/example.mjs', 'lf'],
    ['config/scripts/nested/deeper/example.mjs', 'lf'],
    ['config/scripts-extra/example.mjs', 'unspecified'],
    ['vendor/config/scripts/example.mjs', 'unspecified'],
    ['config/scripts/example.mjsx', 'unspecified']
  ])('resolves %s to eol=%s', (path, expected) => {
    expect(eolAttributes([path]).get(path)).toBe(expected)
  })
})
