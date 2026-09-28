import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Ratchet gate for the mobile test typecheck.
//
// mobile/tsconfig.json excludes *.test.ts so Metro never compiles tests into the release bundle,
// and vitest transpiles without typechecking. Nothing checked a mobile test until tsconfig.test.json
// existed, so 144 of the 632 test files had accumulated type errors — overwhelmingly one seam, the
// react-test-renderer / mocked-react-native pair, whose fix is a test-support typing decision rather
// than 587 local edits. This check freezes that set and fails when a test file that typechecks today
// stops doing so. The baseline may only shrink.

const BASELINE_PATH = 'tests-typecheck-baseline.txt'
const PROJECT = 'tsconfig.test.json'
const ERROR_LINE = /^(\S.*?)\(\d+,\d+\): error TS\d+:/

// The only test files allowed to sit outside the program, and why. Everything else on disk must be
// in it: the error diff below sees a file only once it errors, so an excluded or shadowed test
// disappears from this gate silently.
export const TESTS_OUTSIDE_PROGRAM = new Map([
  [
    'scripts/rpc-recording-pin-guard.test.ts',
    'Node-side: imports the desktop main process, checked against @types/node rather than RN libs'
  ],
  [
    'src/tasks/agent-launch-mobile-replay.test.ts',
    'Node-side: imports the desktop main process, checked against @types/node rather than RN libs'
  ],
  [
    'src/tasks/mobile-agent-launch-architecture.test.ts',
    'Node-side: imports the desktop main process, checked against @types/node rather than RN libs'
  ],
  [
    'src/transport/mobile-relay-browser-cancel-budget.test.ts',
    'Node-side: imports src/shared/child-process, checked against @types/node rather than RN libs'
  ]
])

// tsc prints the host's own separator; the baseline stores POSIX, so a Windows run would otherwise
// read every entry as both stale and added.
const toPosix = (filePath) => filePath.replaceAll('\\', '/')

export function parseFailingFiles(tscOutput) {
  const files = new Set()
  for (const line of tscOutput.split('\n')) {
    const matched = ERROR_LINE.exec(line)
    if (matched) {
      files.add(toPosix(matched[1]))
    }
  }
  return [...files].sort()
}

export function collectTestFilesOnDisk(root = process.cwd()) {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue
      }
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(rel)
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        found.push(rel)
      }
    }
  }
  walk('')
  return found.sort()
}

// --listFiles prints one absolute real path per line into the same stream as the diagnostics; a
// diagnostic carries `(line,col): error` and a path relative to cwd, so neither filter can take the
// other's lines.
export function parseProgramTestFiles(tscOutput, realRoot) {
  const prefix = `${toPosix(realRoot).replace(/\/$/, '')}/`
  return [
    ...new Set(
      tscOutput
        .split('\n')
        .map((line) => toPosix(line.trim()))
        .filter((line) => /\.test\.tsx?$/.test(line) && line.startsWith(prefix))
        .map((line) => line.slice(prefix.length))
    )
  ].sort()
}

// A baselined test could otherwise be "fixed" with one `@ts-nocheck`, pruned, and never checked
// again: tsc exits 0 on such a file and nothing else here would notice.
export function hasTsNocheckDirective(source) {
  for (const line of source.split('\n')) {
    const text = line.trim()
    if (text === '') {
      continue
    }
    if (!text.startsWith('//') && !text.startsWith('/*') && !text.startsWith('*')) {
      return false
    }
    if (text.includes('@ts-nocheck')) {
      return true
    }
  }
  return false
}

export function findTsNocheckFiles(root, files) {
  return files
    .filter((file) => hasTsNocheckDirective(fs.readFileSync(path.join(root, file), 'utf8')))
    .sort()
}

export function diffCensus(onDisk, inProgram, allowed = TESTS_OUTSIDE_PROGRAM) {
  const program = new Set(inProgram)
  const allow = allowed instanceof Map ? allowed : new Map(allowed.map((e) => [e, '']))
  const disk = new Set(onDisk)
  return {
    missing: [...disk].filter((entry) => !program.has(entry) && !allow.has(entry)).sort(),
    staleAllowance: [...allow.keys()]
      .filter((entry) => !disk.has(entry) || program.has(entry))
      .sort()
  }
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

// Run tsc's JS entry on this Node rather than the node_modules/.bin shim, which is a POSIX shell
// script: on Windows the shim is tsc.CMD and an extensionless path gets .exe appended.
function runTsc(root, args) {
  const entry = createRequire(import.meta.url).resolve('typescript/lib/tsc.js')
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error) {
    throw result.error
  }
  return result
}

// tsc exits non-zero on type errors, which is the expected state here, so only a crash is fatal.
// One pass answers both questions: --listFiles names the program, the diagnostics name the failures.
export function collectTypecheckPass(root = process.cwd()) {
  const result = runTsc(root, ['--noEmit', '--listFiles', '-p', PROJECT])
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return {
    failing: parseFailingFiles(output),
    programTestFiles: parseProgramTestFiles(output, fs.realpathSync(root))
  }
}

export function collectCurrentFailingFiles(root = process.cwd()) {
  return collectTypecheckPass(root).failing
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

function printCensusFailure(missing, staleAllowance, nocheck = []) {
  for (const entry of missing) {
    console.error(`::error::Test file is not in the typecheck program: ${entry}`)
  }
  for (const entry of staleAllowance) {
    console.error(`::error::Stale TESTS_OUTSIDE_PROGRAM entry: ${entry}`)
  }
  for (const entry of nocheck) {
    console.error(`::error::Test file opts out of checking with @ts-nocheck: ${entry}`)
  }
  console.error('')
  console.error('╭────────────────────────────────────────────────────────────────────────────╮')
  console.error('│  ❌  mobile tests typecheck census failed — a test file is unchecked.         │')
  console.error('╰────────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  if (missing.length > 0) {
    console.error(`  ${missing.length} test file(s) on disk are outside \`tsc -p ${PROJECT}\`:`)
    console.error('')
    for (const entry of missing) {
      console.error(`    • ${entry}`)
    }
    console.error('')
    console.error('  Usual causes: an added `exclude` entry, or a `Foo.test.tsx` shadowed by a')
    console.error('  `Foo.test.ts` beside it — a wildcard `include` keeps only the higher-priority')
    console.error('  extension, so the .tsx silently leaves the program. Rename one, or exclude it')
    console.error('  on purpose by adding it to TESTS_OUTSIDE_PROGRAM with its reason.')
    console.error('')
  }
  if (staleAllowance.length > 0) {
    console.error(`  ${staleAllowance.length} TESTS_OUTSIDE_PROGRAM entr(y/ies) no longer apply`)
    console.error('  (the file is gone, or it is in the program now). Remove them:')
    console.error('')
    for (const entry of staleAllowance) {
      console.error(`    • ${entry}`)
    }
    console.error('')
  }
  if (nocheck.length > 0) {
    console.error(`  ${nocheck.length} test file(s) carry @ts-nocheck, which makes tsc exit 0 on`)
    console.error('  them. That would let a baselined file be pruned and never checked again:')
    console.error('')
    for (const entry of nocheck) {
      console.error(`    • ${entry}`)
    }
    console.error('')
  }
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(
      `::error::Missing mobile/${BASELINE_PATH}. Generate it with: node scripts/check-tests-typecheck-ratchet.mjs --init`
    )
    return 1
  }
  const pass = collectTypecheckPass(root)
  const census = diffCensus(collectTestFilesOnDisk(root), pass.programTestFiles)
  const nocheck = findTsNocheckFiles(root, pass.programTestFiles)
  if (census.missing.length > 0 || census.staleAllowance.length > 0 || nocheck.length > 0) {
    printCensusFailure(census.missing, census.staleAllowance, nocheck)
    return 1
  }

  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = pass.failing
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
    `mobile tests typecheck ratchet OK — ${pass.programTestFiles.length} test file(s) in the program (${TESTS_OUTSIDE_PROGRAM.size} excluded on purpose, none @ts-nocheck), ${current.length} grandfathered file(s), every other test file checks.`
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
