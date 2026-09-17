import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Ratchet gate for the mobile test typecheck.
//
// mobile/tsconfig.json excludes *.test.ts so Metro never compiles tests into the release bundle,
// and vitest transpiles without typechecking. Nothing checked a mobile test until tsconfig.test.json
// existed, so 144 of the 630 test files had accumulated type errors — overwhelmingly one seam, the
// react-test-renderer / mocked-react-native pair, whose fix is a test-support typing decision rather
// than 587 local edits. This check freezes that set and fails when a test file that typechecks today
// stops doing so. The baseline may only shrink.

const BASELINE_PATH = 'tests-typecheck-baseline.txt'
const PROJECT = 'tsconfig.test.json'
const ERROR_LINE = /^(\S.*?)\(\d+,\d+\): error TS\d+:/

export function parseFailingFiles(tscOutput) {
  const files = new Set()
  for (const line of tscOutput.split('\n')) {
    const matched = ERROR_LINE.exec(line)
    if (matched) {
      files.add(matched[1])
    }
  }
  return [...files].sort()
}

export function parseBaseline(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  )
}

export function diffBaseline(current, baseline) {
  const cur = new Set(current)
  const base = baseline instanceof Set ? baseline : new Set(baseline)
  return {
    added: [...cur].filter((entry) => !base.has(entry)).sort(),
    stale: [...base].filter((entry) => !cur.has(entry)).sort()
  }
}

// tsc exits non-zero on type errors, which is the expected state here, so only a crash is fatal.
function runTypecheck(root) {
  const tsc = path.join(root, 'node_modules', '.bin', 'tsc')
  const result = spawnSync(tsc, ['--noEmit', '-p', PROJECT], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error) {
    throw result.error
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

export function collectCurrentFailingFiles(root = process.cwd()) {
  return parseFailingFiles(runTypecheck(root))
}

function printAddedFailure(added) {
  for (const entry of added) {
    console.error(`::error::Test file no longer typechecks: ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ❌  mobile tests typecheck ratchet failed — a test file stopped checking.    │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${added.length} test file(s) newly fail \`tsc -p ${PROJECT}\`:`)
  console.error('')
  for (const entry of added) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error('  See the errors with:  pnpm --filter orca-mobile typecheck:tests')
  console.error('')
  console.error('  A type-level pin in an unchecked test proves nothing, which is the whole reason')
  console.error('  this gate exists. Fix the test rather than adding it to the baseline.')
  console.error('')
}

function printStaleFailure(stale) {
  for (const entry of stale) {
    console.error(`::error::Stale tests-typecheck baseline entry (prune it): ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error(
    '│  ⚠️  tests-typecheck baseline is out of date — nice work fixing a test!        │'
  )
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${stale.length} baseline entr(y/ies) now typecheck clean.`)
  console.error('  The baseline may only shrink, so these must be removed to keep them checked:')
  console.error('')
  for (const entry of stale) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error(
    `  ✅  Fix it (one command):  pnpm --filter orca-mobile check:tests-typecheck --prune`
  )
  console.error('')
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(
      `::error::Missing mobile/${BASELINE_PATH}. Generate it with: node scripts/check-tests-typecheck-ratchet.mjs --init`
    )
    return 1
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = collectCurrentFailingFiles(root)
  const { added, stale } = diffBaseline(current, baseline)

  if (added.length > 0) {
    printAddedFailure(added)
    if (stale.length > 0) {
      printStaleFailure(stale)
    }
    return 1
  }
  if (stale.length > 0) {
    printStaleFailure(stale)
    return 1
  }
  console.log(
    `mobile tests typecheck ratchet OK — ${current.length} grandfathered file(s), every other test file checks.`
  )
  return 0
}

function writeBaseline(root, entries) {
  const header = [
    '# Test files that do NOT yet typecheck under mobile/tsconfig.test.json.',
    '# This is a RATCHET: the list may only SHRINK. Do NOT add entries to get CI green —',
    '# an unchecked test is one whose type-level pins prove nothing.',
    '# Regenerate/prune: node scripts/check-tests-typecheck-ratchet.mjs --prune',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(root, BASELINE_PATH), `${header}${entries.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  if (arg === '--init') {
    const entries = collectCurrentFailingFiles(root)
    writeBaseline(root, entries)
    console.log(`Wrote mobile/${BASELINE_PATH} with ${entries.length} entries.`)
    process.exit(0)
  }
  if (arg === '--prune') {
    const current = new Set(collectCurrentFailingFiles(root))
    const baseline = parseBaseline(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
    const kept = [...baseline].filter((entry) => current.has(entry)).sort()
    const newlyAdded = [...current].filter((entry) => !baseline.has(entry))
    writeBaseline(root, kept)
    console.log(
      `Pruned baseline to ${kept.length} entries (removed ${baseline.size - kept.length}).`
    )
    if (newlyAdded.length > 0) {
      console.error(
        `::error::--prune does not add entries; ${newlyAdded.length} test file(s) newly fail — fix those.`
      )
      process.exit(1)
    }
    process.exit(0)
  }
  process.exit(main(root))
}
