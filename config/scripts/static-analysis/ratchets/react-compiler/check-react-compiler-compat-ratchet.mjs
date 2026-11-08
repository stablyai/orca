import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { transform } from 'oxc-transform-react'
import {
  diffCounts,
  formatCountBaseline,
  parseCountBaseline,
  parseCountNotes,
  pruneCountBaseline,
  readTrackedSources,
  totalCount
} from '../../ratchet-baseline/ratchet-baseline.mjs'
import {
  HAZARD_FIXES,
  findMemoizedCalls,
  findSourceHazards,
  hookCallLines,
  renderStoreReadLines
} from './react-compiler-hazards.mjs'

// Runs React Compiler (analysis only, nothing is written) over the renderer so code that compiles
// today keeps compiling, and code that would change behavior once compiled can't be added.

const SCAN_ROOT = 'src/renderer/src'
const BAILOUT_BASELINE = 'config/react-compiler-bailout-baseline.txt'
const HAZARD_BASELINE = 'config/react-compiler-hazard-baseline.txt'
const COMMAND = 'pnpm check:react-compiler-compat-ratchet'
const NOT_SHIPPED =
  /(?:^|\/)__(?:mocks|fixtures|tests)__\/|\.(?:test|spec|bench)\.[cm]?tsx?$|[.-]test-|[.-]fixtures?\.tsx?$/
const COMPILER_OPTIONS = {
  jsx: 'preserve',
  reactCompiler: { target: '19', reportDiagnostics: true },
  sourcemap: false
}
const IN_FLIGHT = 32
const BAILOUT_HEADER = [
  '# React Compiler diagnostics (functions it skips) per renderer file. Generated; never hand-edit.',
  `# Lower after a fix: ${COMMAND} --prune. Regenerate (compiler bump, reviewed exception): --update`
]
const HAZARD_HEADER = [
  '# Grandfathered code React Compiler would run differently (<file>#<function>:<hazard>).',
  `# Generated; never hand-edit. Lower after a fix: ${COMMAND} --prune`
]
const BAILOUT_FIXES = [
  [
    /Cannot access refs during render/,
    'Read the ref in an effect or event handler, or keep the value in state.'
  ],
  [
    /cannot be modified|Cannot modify|Cannot reassign/,
    'Copy before changing it; never mutate props, state, hook results or values after render.'
  ],
  [
    /TryStatement with a finalizer|`try`\/`finally`/,
    'Move the try/finally into a module-level function the component calls.'
  ],
  [/Logical assignment operators/, 'Rewrite `a ??= b` as an explicit `if (a == null) a = b`.'],
  [/rule suppression/, 'Remove the react-hooks lint suppression and satisfy the rule.'],
  [
    /memoization could not be preserved/,
    'Make the useMemo/useCallback deps list exactly what the callback reads.'
  ],
  [/incompatible library/, 'Isolate the incompatible API in a small component or hook of its own.']
]

export function isScannedPath(rel) {
  return (
    rel.startsWith(`${SCAN_ROOT}/`) &&
    /\.tsx?$/.test(rel) &&
    !rel.endsWith('.d.ts') &&
    !NOT_SHIPPED.test(rel.slice(SCAN_ROOT.length))
  )
}

// Diagnostic spans are UTF-8 byte offsets.
function lineAt(bytes, offset) {
  let line = 1
  for (
    let index = bytes.indexOf(10);
    index !== -1 && index < offset;
    index = bytes.indexOf(10, index + 1)
  ) {
    line += 1
  }
  return line
}

function addTo(map, key, value) {
  map.set(key, [...(map.get(key) ?? []), value])
}

async function scanFile(rel, text, result) {
  const output = await transform(rel, text, COMPILER_OPTIONS)
  if (output.fatal) {
    addTo(result.diagnostics, rel, { line: 0, message: output.errors[0]?.message ?? 'fatal' })
    return
  }
  result.compiled += output.code.match(/= _c\d*\(\d+\)/g)?.length ?? 0
  const bytes = Buffer.from(text)
  for (const error of output.errors) {
    const message = error.message.split('\n')[0]
    addTo(result.diagnostics, rel, { line: lineAt(bytes, error.labels[0]?.start ?? 0), message })
  }
  for (const hazard of findSourceHazards(rel, text)) {
    addTo(result.hazards, `${rel}#${hazard.fn}:${hazard.kind}`, `${hazard.line}: ${hazard.text}`)
  }
  const storeReadFns = new Set()
  for (const { fn, kind, name } of findMemoizedCalls(rel, output.code)) {
    if (kind === 'store-read') {
      storeReadFns.add(fn)
      continue
    }
    const lines = hookCallLines(rel, text, fn, name)
    addTo(result.hazards, `${rel}#${fn}:hook-in-memo-block`, `${lines.join(', ')}: ${name}()`)
  }
  for (const fn of storeReadFns) {
    // A read inside the source's own useMemo keeps its written deps, so only render-level ones count.
    for (const line of renderStoreReadLines(rel, text, fn)) {
      addTo(result.hazards, `${rel}#${fn}:store-read-in-memo-block`, `${line}: getState()`)
    }
  }
}

export async function scanRenderer(root = process.cwd()) {
  const result = { files: 0, compiled: 0, diagnostics: new Map(), hazards: new Map() }
  const pending = [...readTrackedSources(root, [SCAN_ROOT], isScannedPath)]
  result.files = pending.length
  await Promise.all(
    Array.from({ length: IN_FLIGHT }, async () => {
      while (pending.length > 0) {
        const [rel, text] = pending.shift()
        await scanFile(rel, text, result)
      }
    })
  )
  return result
}

const countsOf = (details) =>
  new Map(
    [...details].map(([key, values]) => [key, values.length]).sort(([a], [b]) => (a < b ? -1 : 1))
  )

function readBaseline(root, rel) {
  const file = path.join(root, rel)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function bailoutFix(message) {
  return (
    BAILOUT_FIXES.find(([pattern]) => pattern.test(message))?.[1] ??
    'Fix or isolate the pattern so the function compiles.'
  )
}

function reportGrowth(kind, grown, details) {
  for (const { file, now, allowed } of grown) {
    console.error(`::error::${file}: ${now} ${kind}, baseline allows ${allowed}.`)
    for (const detail of details.get(file) ?? []) {
      if (kind === 'bailout(s)') {
        console.error(
          `  ${file}:${detail.line} ${detail.message}\n    Fix: ${bailoutFix(detail.message)}`
        )
      } else {
        console.error(`  line ${detail}`)
      }
    }
    if (kind === 'hazard(s)') {
      console.error(`  ${HAZARD_FIXES[file.slice(file.lastIndexOf(':') + 1)].join('\n  ')}`)
    }
  }
}

// Under check:changed (ORCA_CODE_QUALITY_BASE set) a shrink fails only in files the change touches;
// elsewhere, e.g. after a stale-CI merge to main, it is a notice so improvements never turn CI red.
export function listTouchedFiles(root, base = process.env.ORCA_CODE_QUALITY_BASE) {
  if (!base) {
    return null
  }
  try {
    const git = (args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const mergeBase = git(['merge-base', 'HEAD', base]).trim()
    const tracked = git(['diff', '--name-only', '--no-renames', '-z', mergeBase]).split('\0')
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
    return new Set([...tracked, ...untracked].filter(Boolean))
  } catch {
    return null
  }
}

const fileOfKey = (key) => key.split('#')[0]

function check(root, label, baselinePath, current, details, touched) {
  const { grown, shrunk } = diffCounts(
    current,
    parseCountBaseline(readBaseline(root, baselinePath))
  )
  reportGrowth(label, grown, details)
  const enforced = new Set(
    shrunk.filter(({ file }) => touched?.has(fileOfKey(file))).map(({ file }) => file)
  )
  for (const { file, now, allowed } of shrunk) {
    const level = enforced.has(file) ? 'error' : 'notice'
    const line = `::${level}::${file}: now ${now} ${label}, baseline ${allowed}. Record it: ${COMMAND} --prune`
    if (level === 'error') {
      console.error(line)
    } else {
      console.log(line)
    }
  }
  if (shrunk.length > 0) {
    const touchedNote =
      enforced.size > 0
        ? ` (${enforced.size} in files this change touches, which must be recorded)`
        : ''
    const write = enforced.size > 0 ? console.error : console.log
    write(
      `\n${shrunk.length} baseline row(s) improved${touchedNote}.\n` +
        `Lock it in: ${COMMAND} --prune\nthen commit ${baselinePath}.`
    )
  }
  return grown.length + enforced.size === 0
}

function writeBaseline(root, baselinePath, header, current) {
  const text = readBaseline(root, baselinePath)
  fs.writeFileSync(
    path.join(root, baselinePath),
    formatCountBaseline(current, header, parseCountNotes(text))
  )
}

export async function main(root = process.cwd(), arg = undefined) {
  const startedAt = performance.now()
  const scan = await scanRenderer(root)
  const bailouts = countsOf(scan.diagnostics)
  const hazards = countsOf(scan.hazards)
  if (arg === '--prune' || arg === '--update') {
    const write = arg === '--prune' ? pruneCountBaseline : writeBaseline
    write(root, BAILOUT_BASELINE, BAILOUT_HEADER, bailouts)
    write(root, HAZARD_BASELINE, HAZARD_HEADER, hazards)
    console.log(
      `Wrote ${BAILOUT_BASELINE} and ${HAZARD_BASELINE}; rerun ${COMMAND} to see what remains.`
    )
    return 0
  }
  const touched = listTouchedFiles(root)
  const ok = [
    check(root, 'bailout(s)', BAILOUT_BASELINE, bailouts, scan.diagnostics, touched),
    check(root, 'hazard(s)', HAZARD_BASELINE, hazards, scan.hazards, touched)
  ].every(Boolean)
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1)
  if (!ok) {
    console.error(`\nreact-compiler-compat ratchet failed (${scan.files} files, ${seconds}s).`)
    return 1
  }
  console.log(
    `react-compiler-compat ratchet OK — ${scan.compiled} functions compile in ${scan.files} files; ` +
      `${totalCount(bailouts)} grandfathered bailouts, ${totalCount(hazards)} hazards (${seconds}s).`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.cwd(), process.argv[2]))
}
