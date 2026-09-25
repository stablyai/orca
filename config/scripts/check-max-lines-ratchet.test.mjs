import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '../../src/shared/child-process/run-process'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

import {
  collectCurrentSuppressions,
  collectMobileBumps,
  defaultLimitForPath,
  diffBaseline,
  hasMaxLinesDisable,
  parseBaseline
} from './check-max-lines-ratchet.mjs'

describe('hasMaxLinesDisable', () => {
  it('detects a bare block disable', () => {
    expect(hasMaxLinesDisable('/* eslint-disable max-lines */\nexport const a = 1\n')).toBe(true)
  })

  it('detects the oxlint spelling', () => {
    expect(hasMaxLinesDisable('/* oxlint-disable max-lines */\n')).toBe(true)
  })

  it('detects a disable with a -- Why reason', () => {
    expect(hasMaxLinesDisable('/* eslint-disable max-lines -- Why: one owner. */\n')).toBe(true)
  })

  it('detects a multi-line block where the reason wraps', () => {
    const src =
      '/* eslint-disable max-lines -- Why: this contract is\n * intentionally centralized. */\nimport x from "y"\n'
    expect(hasMaxLinesDisable(src)).toBe(true)
  })

  it('detects max-lines inside a compound rule list', () => {
    expect(hasMaxLinesDisable('/* eslint-disable no-control-regex, max-lines -- Why: x */\n')).toBe(
      true
    )
    expect(hasMaxLinesDisable('/* eslint-disable max-lines, no-control-regex */\n')).toBe(true)
  })

  it('detects a line-scoped disable', () => {
    expect(hasMaxLinesDisable('const a = 1 // eslint-disable-line max-lines\n')).toBe(true)
  })

  it('ignores a disable for an unrelated rule', () => {
    expect(hasMaxLinesDisable('/* eslint-disable no-console */\n')).toBe(false)
  })

  it('does not treat "max-lines" appearing only in the reason text as a suppression', () => {
    // max-lines is after the `--`, so it is prose, not a suppressed rule.
    expect(
      hasMaxLinesDisable('/* eslint-disable no-console -- we could hit max-lines later */\n')
    ).toBe(false)
  })

  it('returns false for ordinary source', () => {
    expect(hasMaxLinesDisable('export function f() {\n  return 42\n}\n')).toBe(false)
  })
})

describe('defaultLimitForPath', () => {
  it('uses 800 for tests, 400 for tsx, 600 for mjs, 300 otherwise', () => {
    expect(defaultLimitForPath('a/b.test.ts')).toBe(800)
    expect(defaultLimitForPath('a/b.spec.tsx')).toBe(800)
    expect(defaultLimitForPath('a/b.tsx')).toBe(400)
    expect(defaultLimitForPath('a/b.mjs')).toBe(600)
    expect(defaultLimitForPath('a/b.ts')).toBe(300)
  })

  it.each(['mts', 'cts'])('uses TypeScript budgets for .%s on either path separator', (ext) => {
    for (const prefix of ['a/b', 'a\\b']) {
      expect(defaultLimitForPath(`${prefix}.${ext}`)).toBe(300)
      expect(defaultLimitForPath(`${prefix}.test.${ext}`)).toBe(800)
      expect(defaultLimitForPath(`${prefix}.spec.${ext}`)).toBe(800)
      expect(defaultLimitForPath(`${prefix}.test.${ext}.backup`)).toBe(300)
      expect(defaultLimitForPath(`${prefix}.testish.${ext}`)).toBe(300)
    }
  })
})

describe('collectMobileBumps', () => {
  it.each(['mts', 'cts'])('only flags .%s overrides above their source or test budget', (ext) => {
    const paths = [`module.${ext}`, `module.test.${ext}`, `module.spec.${ext}`]
    const config = (extra) =>
      JSON.stringify({
        overrides: paths.map((file, index) => ({
          files: [file],
          rules: { 'max-lines': ['error', { max: (index === 0 ? 300 : 800) + extra }] }
        }))
      })
    expect(collectMobileBumps(config(-1))).toEqual([])
    expect(collectMobileBumps(config(0))).toEqual([])
    expect(collectMobileBumps(config(1))).toEqual(paths.map((file) => `mobile-config ${file}`))
  })
  it('captures only overrides whose max exceeds the default for the glob', () => {
    const cfg = JSON.stringify({
      overrides: [
        { files: ['app/h/*/tasks.tsx'], rules: { 'max-lines': ['error', { max: 14682 }] } }, // bump (>400)
        {
          files: ['src/terminal/TerminalWebView.tsx'],
          rules: { 'max-lines': ['error', { max: 379 }] }
        }, // stricter (<400), skip
        { files: ['scripts/mock-server.ts'], rules: { 'max-lines': ['error', { max: 407 }] } } // bump (>300)
      ]
    })
    expect(collectMobileBumps(cfg)).toEqual([
      'mobile-config app/h/*/tasks.tsx',
      'mobile-config scripts/mock-server.ts'
    ])
  })

  it('ignores overrides without a max-lines rule', () => {
    const cfg = JSON.stringify({
      overrides: [{ files: ['a.tsx'], rules: { 'no-console': 'off' } }]
    })
    expect(collectMobileBumps(cfg)).toEqual([])
  })
})

describe('max-lines repository coverage', () => {
  let scratch
  const repoRoot = resolve(import.meta.dirname, '../..')

  function write(relativePath, content) {
    const file = join(scratch, relativePath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-max-lines-'))
    const result = runProcessSync({ program: 'git', args: ['init', '--quiet'], cwd: scratch })
    expect(result.code, result.stderr).toBe(0)
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('collects tracked TypeScript and mjs suppressions while ignoring unrelated files', () => {
    const files = [
      'plain.ts',
      'view.tsx',
      'script.mjs',
      'nested folder/module.mts',
      'nested/module.cts'
    ]
    for (const file of files) {
      write(file, '/* oxlint-disable max-lines */\nexport const value = 1\n')
    }
    write('plain.mts.backup', '/* oxlint-disable max-lines */\n')
    write('plain.ctsx', '/* oxlint-disable max-lines */\n')
    write('ordinary.mts', 'export const value = 1\n')
    write('ordinary.cts', 'export const value = 1\n')
    write('config/scripts/check-max-lines-ratchet.test.mjs', '/* oxlint-disable max-lines */\n')
    const result = runProcessSync({ program: 'git', args: ['add', '.'], cwd: scratch })
    expect(result.code, result.stderr).toBe(0)
    write('untracked.mts', '/* oxlint-disable max-lines */\n')
    expect(collectCurrentSuppressions(scratch)).toEqual(
      files.map((file) => `inline ${file}`).sort()
    )
  })

  it.each(['.oxlintrc.json', 'mobile/.oxlintrc.json'])(
    'enforces exact budgets with installed oxlint and %s',
    (config) => {
      rmSync(scratch, { recursive: true, force: true })
      scratch = mkdtempSync(join(dirname(join(repoRoot, config)), '.max-lines-test-'))
      const initialized = runProcessSync({
        program: 'git',
        args: ['init', '--quiet'],
        cwd: scratch
      })
      expect(initialized.code, initialized.stderr).toBe(0)
      const budgets = [
        ['ts', 300],
        ['mts', 300],
        ['cts', 300],
        ['tsx', 400],
        ['mjs', 600],
        ...['ts', 'tsx', 'mts', 'cts'].flatMap((ext) => [
          [`test.${ext}`, 800],
          [`spec.${ext}`, 800]
        ])
      ]
      const expected = []
      for (const [ext, limit] of budgets) {
        for (const extra of [0, 1]) {
          const file = `nested/module-${extra}.${ext}`
          write(
            file,
            `// Comments and blank lines do not count.\n\n${Array.from(
              { length: limit + extra },
              (_, index) => `export const value${index} = ${index}\n`
            ).join('')}`
          )
          if (extra) {
            expected.push(file)
          }
        }
      }
      const invocation = resolveOxlintInvocation(repoRoot)
      const tracked = runProcessSync({ program: 'git', args: ['add', '.'], cwd: scratch })
      expect(tracked.code, tracked.stderr).toBe(0)
      const result = runProcessSync({
        program: invocation.command,
        args: [
          ...invocation.prefixArgs,
          '--config',
          join(repoRoot, config),
          '--format',
          'json',
          '.'
        ],
        cwd: scratch
      })
      expect(result.code, result.stderr).toBe(1)
      const output = JSON.parse(result.stdout)
      expect(output.number_of_files).toBe(budgets.length * 2)
      expect(
        output.diagnostics.every((diagnostic) => diagnostic.code === 'eslint(max-lines)')
      ).toBe(true)
      expect(
        output.diagnostics.map((diagnostic) => diagnostic.filename.replaceAll('\\', '/')).sort()
      ).toEqual(expected.sort())
    }
  )
})

describe('parseBaseline', () => {
  it('drops comments and blank lines', () => {
    const b = parseBaseline('# header\n\ninline a.ts\nmobile-config x/*.tsx\n')
    expect(b).toEqual(new Set(['inline a.ts', 'mobile-config x/*.tsx']))
  })
})

describe('diffBaseline', () => {
  it('reports added and stale entries', () => {
    const { added, stale } = diffBaseline(
      ['inline b.ts', 'inline c.ts'],
      new Set(['inline a.ts', 'inline b.ts'])
    )
    expect(added).toEqual(['inline c.ts']) // new bypass
    expect(stale).toEqual(['inline a.ts']) // suppression removed
  })

  it('is clean when current matches baseline', () => {
    const { added, stale } = diffBaseline(['inline a.ts'], new Set(['inline a.ts']))
    expect(added).toEqual([])
    expect(stale).toEqual([])
  })
})
