import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  changedFileScope,
  countFindings,
  listChangedFiles,
  main
} from './check-flaky-test-pattern-ratchet.mjs'

describe('countFindings', () => {
  it('counts each rule per file, folding TSX twins and Windows separators', () => {
    const counts = countFindings(
      [
        { ruleId: 'test-no-wall-clock', file: 'src/a.test.ts' },
        { ruleId: 'test-no-wall-clock', file: 'src\\a.test.ts' },
        { ruleId: 'test-no-wall-clock-tsx', file: 'src/b.test.tsx' },
        { ruleId: 'test-no-real-time-wait', file: 'src/a.test.ts' },
        { ruleId: 'test-no-real-time-wait', file: 'scratch.test.ts' }
      ],
      (file) => file !== 'scratch.test.ts'
    )

    expect([...counts]).toEqual([
      ['test-no-wall-clock:src/a.test.ts', 2],
      ['test-no-wall-clock:src/b.test.tsx', 1],
      ['test-no-real-time-wait:src/a.test.ts', 1]
    ])
  })
})

describe('changedFileScope', () => {
  it('limits enforcement to findings in changed files', () => {
    const inScope = changedFileScope(new Set(['src/a.test.ts']))

    expect(inScope('test-no-wall-clock:src/a.test.ts')).toBe(true)
    expect(inScope('test-no-wall-clock:src/b.test.ts')).toBe(false)
    expect(changedFileScope(null)).toBeUndefined()
  })
})

describe('listChangedFiles', () => {
  let fixture
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args
      ],
      { cwd: fixture, encoding: 'utf8' }
    ).trim()
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(fixture, { recursive: true, force: true })
  })

  const existingTest = [
    "import { watch } from './old-owner'",
    "import type { Snapshot } from './old-types'",
    "import './old-startup'",
    '// ast-grep-ignore: test-no-wall-clock -- import declaration only',
    "import { read } from './old-reader'",
    'void watch',
    'void read',
    'Date.now()',
    ''
  ].join('\n')
  const movedImports = existingTest.replaceAll('./old-', './new-')
  const createExistingTest = (source = existingTest) => {
    fixture = mkdtempSync(join(tmpdir(), 'flaky-ratchet-imports-'))
    git('init', '-q')
    mkdirSync(join(fixture, 'config'))
    writeFileSync(join(fixture, 'config/flaky-test-pattern-baseline.txt'), '')
    writeFileSync(join(fixture, 'existing.test.ts'), source)
    git('add', '.')
    git('commit', '-qm', 'base')
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', git('rev-parse', 'HEAD'))
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '')
  }

  it('does not newly enforce existing debt when only static import paths change', () => {
    createExistingTest()
    writeFileSync(join(fixture, 'existing.test.ts'), movedImports)
    const matches = [{ file: 'existing.test.ts', ruleId: 'test-no-wall-clock' }]
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(main(fixture, undefined, matches)).toBe(0)
    writeFileSync(join(fixture, 'existing.test.ts'), `${movedImports}Date.now()\n`)
    expect(main(fixture, undefined, [...matches, ...matches])).toBe(1)
    writeFileSync(join(fixture, 'existing.test.ts'), movedImports)
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '1')
    expect(main(fixture, undefined, matches)).toBe(1)
  })

  it.each([
    ['a new finding', `${movedImports}Date.now()\n`],
    ['a changed suppression comment', movedImports.replace('declaration only', 'new reason')],
    ['an import binding change', movedImports.replace('{ watch }', '{ watch as renamed }')],
    [
      'an import type flag change',
      movedImports.replace('import type { Snapshot }', 'import { Snapshot }')
    ],
    ['a body change', movedImports.replace('Date.now()', 'performance.now()')],
    ['a whitespace change', `${movedImports}\n`],
    ['a parse failure', `${movedImports})\n`]
  ])('keeps %s in enforcement scope alongside import path changes', (_label, current) => {
    createExistingTest()
    writeFileSync(join(fixture, 'existing.test.ts'), current)

    expect(listChangedFiles(fixture).has('existing.test.ts')).toBe(true)
  })

  it('keeps dynamic imports and export paths in enforcement scope', () => {
    const source = `${existingTest}void import('./old-dynamic')\nexport { value } from './old-export'\n`
    createExistingTest(source)
    writeFileSync(join(fixture, 'existing.test.ts'), source.replaceAll('./old-', './new-'))

    expect(listChangedFiles(fixture).has('existing.test.ts')).toBe(true)
  })

  it('keeps import-only changes to an unparseable original in enforcement scope', () => {
    createExistingTest(`${existingTest})\n`)
    writeFileSync(join(fixture, 'existing.test.ts'), `${movedImports})\n`)

    expect(listChangedFiles(fixture).has('existing.test.ts')).toBe(true)
  })

  it('keeps added and deleted files in enforcement scope', () => {
    createExistingTest()
    rmSync(join(fixture, 'existing.test.ts'))
    writeFileSync(join(fixture, 'added.test.ts'), movedImports)
    git('add', '.')

    expect([...listChangedFiles(fixture)].sort()).toEqual(['added.test.ts', 'existing.test.ts'])
  })

  it('enforces findings in tracked files whose names Git quotes', () => {
    fixture = mkdtempSync(join(tmpdir(), 'flaky-ratchet-path-'))
    git('init', '-q')
    git('config', 'core.quotePath', 'true')
    git('commit', '--allow-empty', '-qm', 'base')
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', git('rev-parse', 'HEAD'))
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '')
    const file = '測試.test.ts'
    writeFileSync(join(fixture, file), 'Date.now()\n')
    git('add', '--', file)
    mkdirSync(join(fixture, 'config'))
    writeFileSync(join(fixture, 'config/flaky-test-pattern-baseline.txt'), '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(main(fixture, undefined, [{ file, ruleId: 'test-no-wall-clock' }])).toBe(1)
    expect(error.mock.calls.join('\n')).toContain(file)
  })

  it('scopes to the base check:changed forwards instead of a stale origin/main', () => {
    fixture = mkdtempSync(join(tmpdir(), 'flaky-ratchet-base-'))
    const commit = (file) => {
      writeFileSync(join(fixture, file), file)
      git('add', file)
      git('commit', '-qm', file)
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q')
    git('update-ref', 'refs/remotes/origin/main', commit('fork-base.txt'))
    const upstream = commit('upstream-drift.txt')
    commit('contribution.txt')
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '')
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', '')

    expect([...listChangedFiles(fixture)].sort()).toEqual([
      'contribution.txt',
      'upstream-drift.txt'
    ])
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', upstream)
    expect([...listChangedFiles(fixture)]).toEqual(['contribution.txt'])
  })
})
