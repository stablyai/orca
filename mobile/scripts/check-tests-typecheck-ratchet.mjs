import { runProcessSync } from '@orca/process-host'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resolveMobileTypecheckCommand } from './mobile-typecheck-compiler.mjs'
import { printNodeTestsFailure, runNodeTestsTypecheck } from './check-node-tests-typecheck.mjs'

// Mobile release tsconfig excludes tests and Vitest does not typecheck; separate test program freezes existing errors with a shrink-only baseline.

const BASELINE_PATH = 'tests-typecheck-baseline.txt'
const PROJECT = 'tsconfig.test.json'
const ERROR_LINE = /^(\S.*?)\(\d+,\d+\): error TS\d+:/

// Tests outside the RN program. Checked transfers are the roots of tsconfig.test.node.json and must pass
// that strict program; the rest are legacy runtime-only allowances whose bodies nothing typechecks.
export const TESTS_OUTSIDE_PROGRAM = new Map([
  [
    'src/components/WorktreeAgentList.runtime-lineage.test.tsx',
    'Legacy runtime-only: the test body is not typechecked anywhere; it imports the desktop SQLite assignment projection, which does not check against RN libs, and its implementation sources keep their normal checks'
  ],
  [
    'src/components/pr-sidebar/reviewer-picker.target-contract.test.tsx',
    'Checked transfer: strict Node program over emitted phone/host declarations (tsconfig.test.node.json)'
  ],
  [
    'src/session/mobile-native-command-discovery.test.tsx',
    'Legacy runtime-only: the test body is not typechecked anywhere; it imports desktop ACP command discovery, which does not check against RN libs, and its implementation sources keep their normal checks'
  ],
  [
    'src/tasks/agent-launch-mobile-replay.test.ts',
    'Legacy runtime-only: the test body is not typechecked anywhere; it imports the desktop main process, which does not check against RN libs, and its implementation sources keep their normal checks'
  ],
  [
    'src/tasks/mobile-agent-launch-architecture.test.ts',
    'Legacy runtime-only: the test body is not typechecked anywhere; it imports the desktop main process, which does not check against RN libs, and its implementation sources keep their normal checks'
  ],
  [
    'src/test-support/rpc-recording/recorded-request-params.test.ts',
    'Checked transfer: strict Node program over emitted phone/host declarations (tsconfig.test.node.json)'
  ],
  [
    'src/transport/mobile-relay-browser-cancel-budget.test.ts',
    'Legacy runtime-only: the test body is not typechecked anywhere; it imports @orca/process-host, which does not check against RN libs, and its implementation sources keep their normal checks'
  ],
  [
    'src/transport/mobile-web-bundle-host-slow-link.test.ts',
    'Legacy runtime-only: the test body is not typechecked anywhere; it imports the desktop bundle RPC handlers, which does not check against RN libs, and its implementation sources keep their normal checks'
  ]
])

// Normalize tsc’s host separators to POSIX baseline paths or Windows reports every entry stale and added.
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

// Separate absolute --listFiles rows from relative (line,col):error diagnostics in their shared stream.
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

// A reason string never satisfies a transfer: its strict program must have passed with the body in it.
export function checkTransfers(result, allowed = TESTS_OUTSIDE_PROGRAM, nocheck = []) {
  const problems = []
  if (!result.ok) {
    problems.push('the phone/host contract program did not pass')
  }
  if (result.expected.length === 0) {
    problems.push('tsconfig.test.node.json names no checked transfer')
  }
  for (const file of result.expected) {
    if (!allowed.has(file)) {
      problems.push(`checked transfer is not excluded from the RN program: ${file}`)
    }
    if (!result.programTestFiles.includes(file)) {
      problems.push(`checked transfer is absent from its program: ${file}`)
    }
    if (nocheck.includes(file)) {
      problems.push(`checked transfer opts out with @ts-nocheck: ${file}`)
    }
  }
  return problems
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

// Type errors are expected; only compiler crash is fatal. One pass collects both program files and diagnostics.
export function collectTypecheckPass(root = process.cwd()) {
  const command = resolveMobileTypecheckCommand(PROJECT, root)
  const result = runProcessSync({
    program: command.program,
    args: [...command.args, '--listFiles'],
    cwd: command.cwd,
    timeoutMs: null,
    maxOutputBytes: 64 * 1024 * 1024
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return {
    failing: parseFailingFiles(output),
    diagnostics: output.split('\n').filter((line) => ERROR_LINE.test(line)),
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

export function main(root = process.cwd(), runNodeTests = () => runNodeTestsTypecheck()) {
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
  // The RN baseline does not apply here: transferred bodies and their declaration producers must be clean.
  const node = runNodeTests()
  const transferProblems = checkTransfers(
    node,
    TESTS_OUTSIDE_PROGRAM,
    findTsNocheckFiles(root, node.expected)
  )
  if (transferProblems.length > 0) {
    printNodeTestsFailure(node)
    for (const problem of transferProblems) {
      console.error(`::error::${problem}`)
    }
  }

  if (added.length > 0) {
    printAddedFailure(added)
    for (const diagnostic of pass.diagnostics) {
      console.error(diagnostic)
    }
    if (stale.length > 0) {
      printStaleFailure(stale)
    }
    return 1
  }
  if (stale.length > 0) {
    printStaleFailure(stale)
    return 1
  }
  if (transferProblems.length > 0) {
    return 1
  }
  const legacy = TESTS_OUTSIDE_PROGRAM.size - node.expected.length
  console.log(
    `mobile tests typecheck ratchet OK — ${pass.programTestFiles.length} test file(s) checked in the RN program (${current.length} grandfathered), ${node.expected.length} checked in the phone/host contract program, ${legacy} legacy runtime-only allowance(s) whose bodies are not typechecked; none @ts-nocheck.`
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
