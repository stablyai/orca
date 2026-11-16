import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  collectChangedFiles,
  computeSetupHash,
  failedTestsFromReports,
  hashChangedFiles,
  planRepairRun,
  readRunRecord,
  writeRunRecord
} from './check-changed-pass-cache.mjs'

let root
let base

function git(...args) {
  const result = runProcessSync({ program: 'git', args, cwd: root })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-changed-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(root, '.gitignore'), '.cache/\n')
  writeFileSync(join(root, 'tracked.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  base = git('rev-parse', 'HEAD')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const snapshot = () => hashChangedFiles(root, collectChangedFiles(root, base))

it('keys file records on working-tree bytes and drops the record when the setup changes', () => {
  expect(collectChangedFiles(root, base)).toEqual([])

  writeFileSync(join(root, 'tracked.ts'), 'export const a = 2\n')
  const unstaged = snapshot()
  const setup = computeSetupHash(root, base)
  writeRunRecord(root, { setup, files: unstaged, tasks: { oxlint: { ok: true } } })
  expect(readRunRecord(root, setup)?.files).toEqual(unstaged)
  expect(collectChangedFiles(root, base)).toEqual(['tracked.ts'])

  git('add', 'tracked.ts')
  git('commit', '-qm', 'edit')
  expect(snapshot()).toEqual(unstaged)

  writeFileSync(join(root, 'new.ts'), 'export const b = 1\n')
  const untracked = snapshot()
  expect(Object.keys(untracked)).toEqual(['new.ts', 'tracked.ts'])
  writeFileSync(join(root, 'new.ts'), 'export const b = 2\n')
  expect(snapshot()['new.ts']).not.toBe(untracked['new.ts'])

  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n')
  const changedSetup = computeSetupHash(root, base)
  expect(changedSetup).not.toBe(setup)
  expect(readRunRecord(root, changedSetup)).toBeNull()
  writeFileSync(join(root, '.cache/check-changed.json'), '{"version":')
  expect(readRunRecord(root, setup)).toBeNull()
})

it('reruns failed checks and narrows tests to edited files plus last failures', () => {
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src/b.ts'), 'export const b = 1\n')
  writeFileSync(join(root, 'src/a.test.ts'), 'it.todo("a")\n')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs/notes.md'), '# notes\n')
  const record = {
    files: snapshot(),
    tasks: {
      typecheck: { ok: true },
      oxlint: { ok: false },
      'unit tests': { ok: false, failedTests: ['src/a.test.ts'] }
    }
  }

  const unedited = planRepairRun(root, record, snapshot(), () => [])
  expect(unedited.edited).toEqual([])
  expect(unedited.passed('typecheck')).toBe(true)
  expect(unedited.passed('oxlint')).toBe(false)
  expect(unedited.unitTests).toEqual({ related: [], colocated: ['src/a.test.ts'] })

  writeFileSync(join(root, 'src/b.ts'), 'export const b = 2\n')
  const edited = planRepairRun(root, record, snapshot(), () => [])
  expect(edited.edited).toEqual(['src/b.ts'])
  expect(edited.passed('typecheck')).toBe(false)
  expect(edited.unitTests).toEqual({ related: ['src/b.ts'], colocated: ['src/a.test.ts'] })

  const passedTests = { ...record.tasks, 'unit tests': { ok: true, failedTests: [] } }
  const lastPassed = { files: snapshot(), tasks: passedTests }
  writeFileSync(join(root, 'docs/notes.md'), '# more notes\n')
  const onlyDocs = planRepairRun(root, lastPassed, snapshot(), () => [])
  expect(onlyDocs.edited).toEqual(['docs/notes.md'])
  expect(onlyDocs.passed('unit tests')).toBe(true)
  expect(onlyDocs.passed('typecheck')).toBe(false)

  // Edits `related` can't follow (snapshots, setup, deletions) bring back every test.
  writeFileSync(join(root, 'src/a.test.ts.snap'), 'exports[`a`] = 1\n')
  expect(planRepairRun(root, lastPassed, snapshot(), () => []).passed('unit tests')).toBe(false)
  rmSync(join(root, 'src/a.test.ts.snap'))
  rmSync(join(root, 'src/b.ts'))
  expect(planRepairRun(root, lastPassed, snapshot(), () => []).unitTests).toBeNull()
})

it('pins failed tests to files only when nothing failed outside them', () => {
  const report = (name, body) => {
    writeFileSync(join(root, name), JSON.stringify(body))
    return join(root, name)
  }
  const failing = report('failing.json', {
    reason: 'failed',
    unhandledErrors: 0,
    failed: [join(root, 'src/a.test.ts')]
  })
  const passing = report('passing.json', { reason: 'passed', unhandledErrors: 0, failed: [] })
  expect(failedTestsFromReports(root, [passing, failing])).toEqual(['src/a.test.ts'])

  const leaked = report('leaked.json', { reason: 'failed', unhandledErrors: 1, failed: [] })
  expect(failedTestsFromReports(root, [failing, leaked])).toBeNull()
  expect(failedTestsFromReports(root, [failing, join(root, 'never-ran.json')])).toBeNull()
})
