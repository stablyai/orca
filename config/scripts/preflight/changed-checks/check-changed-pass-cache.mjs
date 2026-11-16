import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { splitUnitTestInputs } from './check-changed-selection.mjs'
import { isDocsOnlyPath } from '../../workflow/source-routing/pr-code-change-scope.mjs'

export const PASS_CACHE_PATH = '.cache/check-changed.json'
export const UNIT_TESTS_TASK = 'unit tests'
const CACHE_VERSION = 2

// Inputs outside the diff that still decide what the checks report.
const HASHED_CONFIG_FILES = [
  'pnpm-lock.yaml',
  'package.json',
  '.oxlintrc.json',
  '.oxfmtrc.json',
  'config/vitest.config.ts',
  'config/scripts/preflight/changed-checks/check-changed.mjs',
  'config/scripts/preflight/changed-checks/check-changed-selection.mjs',
  'config/scripts/preflight/changed-checks/check-changed-pass-cache.mjs',
  'config/scripts/preflight/changed-checks/check-changed-vitest-reporter.mjs'
]

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean)
}

function readIfFile(file) {
  try {
    return statSync(file).isFile() ? readFileSync(file) : null
  } catch {
    return null
  }
}

/** Committed, staged, unstaged, and untracked paths relative to the merge base, deletions included. */
export function collectChangedFiles(root, mergeBase) {
  const tracked = splitNullDelimited(
    git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase, '--'])
  )
  const untracked = splitNullDelimited(
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
  return [...new Set([...tracked, ...untracked])].sort()
}

/** Everything besides the diff that a recorded run depends on; any change forces a full run. */
export function computeSetupHash(root, mergeBase) {
  const hash = createHash('sha256')
  const field = (label, value) => {
    hash.update(`${label}\0${value.length}\0`)
    hash.update(value)
  }
  field('version', String(CACHE_VERSION))
  field('runtime', `${process.platform} ${process.arch} ${process.version}`)
  field('base', mergeBase)
  for (const file of HASHED_CONFIG_FILES) {
    field('config', file)
    field('content', readIfFile(path.join(root, file)) ?? '')
  }
  return hash.digest('hex')
}

// Working-tree bytes, not git state, so staging or committing a checked edit keeps its record.
export function hashChangedFiles(root, files) {
  return Object.fromEntries(
    files.map((file) => {
      const content = readIfFile(path.join(root, file))
      return [file, content ? createHash('sha256').update(content).digest('hex') : 'deleted']
    })
  )
}

/** The last run in this worktree, or null when it was against another setup or is unreadable. */
export function readRunRecord(root, setup) {
  try {
    const record = JSON.parse(readFileSync(path.join(root, PASS_CACHE_PATH), 'utf8'))
    const tasks = Object.values(record.tasks ?? {})
    return record.version === CACHE_VERSION &&
      record.setup === setup &&
      Object.values(record.files ?? {}).every((hash) => typeof hash === 'string') &&
      tasks.length === Object.keys(record.tasks).length &&
      tasks.every(isTaskRecord)
      ? record
      : null
  } catch {
    return null
  }
}

function isTaskRecord(task) {
  return (
    typeof task?.ok === 'boolean' &&
    (task.failedTests == null ||
      (Array.isArray(task.failedTests) &&
        task.failedTests.every((file) => typeof file === 'string')))
  )
}

export function writeRunRecord(root, { setup, files, tasks }) {
  const file = path.join(root, PASS_CACHE_PATH)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ version: CACHE_VERSION, setup, files, tasks, ranAt: new Date().toISOString() })}\n`
  )
}

/**
 * What a repeat run against the same setup still has to do; null means run everything.
 * Checks that passed are skipped until a file changes. Unit tests narrow to the files edited
 * since the last run plus the test files that failed in it, since the rest already passed.
 */
export function planRepairRun(root, record, files, listDirectory) {
  if (!record) {
    return null
  }
  const edited = [...new Set([...Object.keys(record.files), ...Object.keys(files)])]
    .filter((file) => record.files[file] !== files[file])
    .sort()
  const unitTests = narrowUnitTests(root, edited, record.tasks[UNIT_TESTS_TASK], listDirectory)
  const nothingToTest = unitTests?.related.length === 0 && unitTests.colocated.length === 0
  return {
    edited,
    passed: (name) =>
      record.tasks[name]?.ok === true &&
      (edited.length === 0 || (name === UNIT_TESTS_TASK && nothingToTest)),
    unitTests: nothingToTest ? null : unitTests
  }
}

function narrowUnitTests(root, edited, unitRecord, listDirectory) {
  const exists = (file) => existsSync(path.join(root, file))
  if (!Array.isArray(unitRecord?.failedTests) || !edited.every(exists)) {
    return null
  }
  // `related` follows imports only: deleted files, setup, config, fixtures and snapshots need all.
  const { related } = splitUnitTestInputs(edited, listDirectory)
  if (edited.some((file) => !related.includes(file) && !isDocsOnlyPath(file))) {
    return null
  }
  return { related, colocated: unitRecord.failedTests.filter(exists) }
}

/** Failed test files from the reporter's output; null unless every run pinned its failure to files. */
export function failedTestsFromReports(root, reportFiles) {
  const failed = new Set()
  for (const reportFile of reportFiles) {
    let report
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'))
    } catch {
      // No report: the run crashed, timed out, or never started after an earlier step failed.
      return null
    }
    if (
      report.reason === 'interrupted' ||
      report.unhandledErrors !== 0 ||
      !Array.isArray(report.failed)
    ) {
      return null
    }
    for (const file of report.failed) {
      failed.add(path.relative(root, file).split(path.sep).join('/'))
    }
  }
  return failed.size > 0 ? [...failed].sort() : null
}
