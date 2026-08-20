// Tracks which test files fail on this platform, so a remediation phase can
// prove it fixed its own cluster without disturbing another.
//
// Deliberately not a pass/fail gate on the absolute count: the Windows suite
// starts from hundreds of known failures, and demanding zero would make the
// tool useless until the very last phase. It fails only on files that got
// worse or were not failing before.
//
//   node config/scripts/windows-suite-baseline.mjs --record
//   node config/scripts/windows-suite-baseline.mjs --compare
//   node config/scripts/windows-suite-baseline.mjs --compare --from-log <path>
//
// `--from-log` reads a log a previous run already produced. The full sweep
// takes about 40 minutes, so re-parsing beats re-running whenever the tree has
// not changed since.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

export const BASELINE_PATH = 'config/windows-suite-baseline.json'

const ANSI_PATTERN = new RegExp(String.raw`\[[0-9;]*m`, 'g')
// Why: anchored at line start. `FAIL` appears in captured stderr often enough
// that a loose match invents failures out of test output.
const FAIL_LINE = /^ *FAIL {1,2}(\S+)/

/** Counts failing entries per file in a vitest run log.
 *
 *  One entry per failing test, plus one for a suite that could not be
 *  collected at all — those report the file and no test name, and are exactly
 *  the failures worth noticing, so they are counted rather than skipped. */
export function parseFailures(logText) {
  const failures = {}
  for (const rawLine of logText.replace(ANSI_PATTERN, '').split('\n')) {
    const match = FAIL_LINE.exec(rawLine)
    if (!match) {
      continue
    }
    // Strip a `:line:col` suffix so moving a test does not read as a new file.
    const file = match[1].replace(/:\d+(:\d+)?$/, '')
    failures[file] = (failures[file] ?? 0) + 1
  }
  return failures
}

function entry(file, before, after) {
  return { file, before, after }
}

/** Compares a run against the recorded baseline.
 *
 *  Progress and regression are reported side by side on purpose: a phase that
 *  fixes its own cluster while breaking another must not read as a win, so
 *  `regressed` is driven by the regressions alone and never offset. */
export function diffBaselines(baseline, current) {
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()
  const newlyFailing = []
  const worse = []
  const better = []
  const fixed = []
  for (const file of files) {
    const before = baseline[file] ?? 0
    const after = current[file] ?? 0
    if (after > before) {
      ;(before === 0 ? newlyFailing : worse).push(entry(file, before, after))
    } else if (after < before) {
      ;(after === 0 ? fixed : better).push(entry(file, before, after))
    }
  }
  return {
    newlyFailing,
    worse,
    better,
    fixed,
    regressed: newlyFailing.length > 0 || worse.length > 0
  }
}

function runSuite() {
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'config/vitest.config.ts'],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
  )
  if (result.error) {
    throw result.error
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function readLog(fromLog) {
  return fromLog ? readFileSync(fromLog, 'utf8') : runSuite()
}

function total(failures) {
  return Object.values(failures).reduce((sum, count) => sum + count, 0)
}

function report(label, rows) {
  if (rows.length === 0) {
    return
  }
  console.log(`\n${label} (${rows.length}):`)
  for (const row of rows) {
    console.log(`  ${row.before} -> ${row.after}  ${row.file}`)
  }
}

function main(argv) {
  const fromLogIndex = argv.indexOf('--from-log')
  const fromLog = fromLogIndex === -1 ? null : argv[fromLogIndex + 1]
  const failures = parseFailures(readLog(fromLog))

  if (argv.includes('--record')) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true })
    writeFileSync(BASELINE_PATH, `${JSON.stringify(failures, null, 2)}\n`)
    console.log(
      `Recorded ${Object.keys(failures).length} files, ${total(failures)} failures -> ${BASELINE_PATH}`
    )
    return 0
  }

  let baseline
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch {
    console.error(`No baseline at ${BASELINE_PATH}. Run with --record first.`)
    return 2
  }
  const diff = diffBaselines(baseline, failures)
  console.log(
    `baseline: ${Object.keys(baseline).length} files / ${total(baseline)} failures\n` +
      `current:  ${Object.keys(failures).length} files / ${total(failures)} failures`
  )
  report('NEWLY FAILING', diff.newlyFailing)
  report('WORSE', diff.worse)
  report('better', diff.better)
  report('fixed', diff.fixed)
  if (diff.regressed) {
    console.error('\nRegression: files got worse or started failing.')
    return 1
  }
  console.log('\nNo regression.')
  return 0
}

// Why: `import.meta.main` is not available on the Node floor this repo targets.
if (process.argv[1] && resolve(process.argv[1]).endsWith('windows-suite-baseline.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
