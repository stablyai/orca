#!/usr/bin/env node
// A tag is judged by its own specs; main's copy may only re-run a vetted spec's failed tests.

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RESCUABLE_HARNESS_FILES = Object.freeze([
  'tests/e2e/golden-source-control-open-diff.spec.ts',
  'tests/e2e/golden-terminal-file-link.spec.ts',
  'tests/e2e/golden-worktree-create-switch.spec.ts'
])

const RESCUE_DIR = 'release-gate-rescue'

// Why: macOS temp and workspace paths can reach Playwright through a symlink (/var vs /private/var).
function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function toRepoPath(repoDir, rootDir, file) {
  const absolute = isAbsolute(file) ? file : resolve(canonicalPath(rootDir), file)
  return relative(canonicalPath(repoDir), absolute).split(sep).join('/')
}

/** Flattens a Playwright JSON report into one entry per test and project. */
export function collectPlaywrightTests(report, repoDir) {
  const rootDir = report?.config?.rootDir ?? repoDir
  const tests = []
  const walk = (suite, describePath) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        tests.push({
          file: toRepoPath(repoDir, rootDir, spec.file),
          suiteFile: spec.file,
          titlePath: [...describePath, spec.title],
          projectName: test.projectName ?? '',
          status: test.status,
          expectedStatus: test.expectedStatus
        })
      }
    }
    for (const child of suite.suites ?? []) {
      walk(child, [...describePath, child.title])
    }
  }
  for (const fileSuite of report?.suites ?? []) {
    walk(fileSuite, [])
  }
  return tests
}

// Why: a serial suite skips the tests after a failure without running them; only a declared skip is not owed a run.
function didNotPass(test) {
  return (
    test.status === 'unexpected' || (test.status === 'skipped' && test.expectedStatus !== 'skipped')
  )
}

function testKey(test) {
  return JSON.stringify([test.file, test.projectName, ...test.titlePath])
}

/** Decides whether a failed tag run may be retried with main's copy of its failed specs. */
export function planHarnessRescue(report, { repoDir, rescuableFiles = RESCUABLE_HARNESS_FILES }) {
  if (!report || !Array.isArray(report.suites)) {
    return { rescuable: false, reason: 'the tag run wrote no readable Playwright JSON report' }
  }
  if ((report.errors ?? []).length > 0) {
    return { rescuable: false, reason: 'the tag run failed outside any test (setup or load error)' }
  }
  const failedTests = collectPlaywrightTests(report, repoDir).filter(didNotPass)
  if (failedTests.length === 0) {
    return { rescuable: false, reason: 'the tag run failed without a failed test to attribute' }
  }
  const outside = [...new Set(failedTests.map((test) => test.file))].filter(
    (file) => !rescuableFiles.includes(file)
  )
  if (outside.length > 0) {
    return {
      rescuable: false,
      reason: `failures outside the rescuable harness specs: ${outside.join(', ')}`
    }
  }
  return { rescuable: true, failedTests, files: [...new Set(failedTests.map((test) => test.file))] }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Selects exactly the failed tests by file and title path for the rescue run. */
export function buildRescueGrep(failedTests) {
  const patterns = [
    ...new Set(
      failedTests.map((test) => escapeRegExp([test.suiteFile, ...test.titlePath].join(' ')))
    )
  ]
  return `(?:${patterns.join('|')})`
}

/** Passes only when every test that failed on the tag ran again and passed on main's copy. */
export function verifyHarnessRescue(failedTests, rescueReport, { repoDir }) {
  if (!rescueReport || !Array.isArray(rescueReport.suites)) {
    return { rescued: false, reason: 'the rescue run wrote no readable Playwright JSON report' }
  }
  if ((rescueReport.errors ?? []).length > 0) {
    return { rescued: false, reason: "main's harness copy failed outside any test" }
  }
  const rescueTests = collectPlaywrightTests(rescueReport, repoDir)
  const unexpected = rescueTests.filter((test) => test.status === 'unexpected')
  if (unexpected.length > 0) {
    return {
      rescued: false,
      reason: `still failing with main's harness copy: ${unexpected.map((test) => test.titlePath.join(' › ')).join('; ')}`
    }
  }
  const byKey = new Map(rescueTests.map((test) => [testKey(test), test]))
  const missing = failedTests.filter((test) => byKey.get(testKey(test))?.status !== 'expected')
  if (missing.length > 0) {
    return {
      rescued: false,
      reason: `not re-run and passed under the same title: ${missing.map((test) => test.titlePath.join(' › ')).join('; ')}`
    }
  }
  return { rescued: true }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function gitObject(repoDir, rev) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', rev], {
    cwd: repoDir,
    encoding: 'utf8'
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function git(repoDir, args) {
  const result = spawnSync('git', args, { cwd: repoDir, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}`)
  }
}

function runGate(command, extraArgs, reportPath, repoDir) {
  const [executable, ...args] = command
  const result = spawnSync(executable, [...args, '--reporter=list,json', ...extraArgs], {
    cwd: repoDir,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath }
  })
  return result.status ?? 1
}

function report(kind, message) {
  console.log(`::${kind}::${message}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`)
  }
}

export function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const options = separator === -1 ? argv : argv.slice(0, separator)
  const command = separator === -1 ? [] : argv.slice(separator + 1)
  const read = (name) => {
    const index = options.indexOf(name)
    return index === -1 ? undefined : options[index + 1]
  }
  const label = read('--label')
  const workflowSha = read('--workflow-sha') ?? process.env.WORKFLOW_SHA
  if (!label || !/^[a-z0-9-]+$/.test(label) || !workflowSha || command.length === 0) {
    throw new Error(
      'usage: release-gate-harness-rescue.mjs --label <name> [--workflow-sha <sha>] -- <command...>'
    )
  }
  return { label, workflowSha, command }
}

export function main(argv = process.argv.slice(2), repoDir = process.cwd()) {
  const { label, workflowSha, command } = parseArgs(argv)
  const evidenceDir = join(repoDir, RESCUE_DIR, label)
  rmSync(evidenceDir, { recursive: true, force: true })
  mkdirSync(evidenceDir, { recursive: true })
  const tagReportPath = join(evidenceDir, 'tag-run.json')

  const tagStatus = runGate(command, [], tagReportPath, repoDir)
  if (tagStatus === 0) {
    return 0
  }

  const plan = planHarnessRescue(readJson(tagReportPath), { repoDir })
  if (!plan.rescuable) {
    report('error', `${label}: the tag's own golden failed and cannot be rescued: ${plan.reason}.`)
    return tagStatus
  }
  const unchanged = plan.files.filter((file) => {
    const workflowBlob = gitObject(repoDir, `${workflowSha}:${file}`)
    return workflowBlob === null || workflowBlob === gitObject(repoDir, `HEAD:${file}`)
  })
  if (unchanged.length > 0) {
    report('error', `${label}: no newer harness on the workflow ref for ${unchanged.join(', ')}.`)
    return tagStatus
  }

  // Why: Playwright empties test-results on every run; keep the tag run's first-failure traces.
  if (existsSync(join(repoDir, 'test-results'))) {
    renameSync(join(repoDir, 'test-results'), join(evidenceDir, 'tag-run-test-results'))
  }
  const rescueReportPath = join(evidenceDir, 'rescue-run.json')
  let rescueStatus
  git(repoDir, ['checkout', workflowSha, '--', ...plan.files])
  try {
    rescueStatus = runGate(
      command,
      [`--grep=${buildRescueGrep(plan.failedTests)}`],
      rescueReportPath,
      repoDir
    )
  } finally {
    git(repoDir, ['checkout', 'HEAD', '--', ...plan.files])
  }

  const verdict = verifyHarnessRescue(plan.failedTests, readJson(rescueReportPath), { repoDir })
  if (rescueStatus !== 0 || !verdict.rescued) {
    report(
      'error',
      `${label}: the tag's own golden failed and main's harness did not rescue it: ${verdict.reason ?? `exit ${rescueStatus}`}.`
    )
    return rescueStatus || 1
  }
  report(
    'warning',
    `${label}: the tag's own copy failed and passed only with the workflow ref's harness for ${plan.files.join(', ')} (${plan.failedTests.length} test(s)); tag-run traces are in the ${RESCUE_DIR} artifact.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main()
}
