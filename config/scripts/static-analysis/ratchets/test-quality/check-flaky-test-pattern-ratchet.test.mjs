import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listChangedFiles, main } from './check-flaky-test-pattern-ratchet.mjs'

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
