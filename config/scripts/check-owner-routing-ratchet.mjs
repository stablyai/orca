import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Ratchet for renderer code that routes host-owned work by the "Active Server" focus setting
// instead of by the resource's own host. The three helpers are counted together so renaming one
// into another never lowers the count. Per-file counts may only go down.

const BASELINE_PATH = 'config/owner-routing-baseline.txt'
const SCAN_ROOT = 'src/renderer/src'
const FOCUS_ROUTING_CALL =
  /(?<!function\s)\b(?:getActiveRuntimeTarget|legacyRouteFromSettings|settingsForRuntimeOwner)\(/g

export function countFocusRoutingCalls(sourceText) {
  return sourceText.match(FOCUS_ROUTING_CALL)?.length ?? 0
}

export function isScannedPath(rel) {
  return /\.(ts|tsx)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel)
}

/** `<count> <path>` lines; `#` comments and blanks ignored. */
export function parseBaseline(text) {
  const counts = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const [count, file] = line.split(/\s+/, 2)
    counts.set(file, Number(count))
  }
  return counts
}

export function formatBaseline(counts) {
  const header = [
    '# Renderer call sites that route by the Active Server focus setting:',
    '# getActiveRuntimeTarget( + legacyRouteFromSettings( + settingsForRuntimeOwner(, per file.',
    '# This is a RATCHET: counts may only go DOWN. Route new work by the resource owner instead.',
    '# Prune after removing sites: pnpm check:owner-routing-ratchet --prune',
    ''
  ].join('\n')
  const rows = [...counts]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, count]) => `${count} ${file}`)
  return `${header}${rows.join('\n')}\n`
}

/** `grown`: above baseline (fails). `shrunk`: below baseline, must be pruned so it cannot regrow. */
export function diffCounts(current, baseline) {
  const grown = []
  const shrunk = []
  for (const file of new Set([...current.keys(), ...baseline.keys()])) {
    const now = current.get(file) ?? 0
    const allowed = baseline.get(file) ?? 0
    if (now > allowed) {
      grown.push({ file, now, allowed })
    } else if (now < allowed) {
      shrunk.push({ file, now, allowed })
    }
  }
  const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  return { grown: grown.sort(byFile), shrunk: shrunk.sort(byFile) }
}

export function collectCurrentCounts(root = process.cwd()) {
  const tracked = execFileSync('git', ['ls-files', SCAN_ROOT], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter((rel) => rel && isScannedPath(rel))
  const counts = new Map()
  for (const rel of tracked) {
    let source
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const count = countFocusRoutingCalls(source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

function total(counts) {
  return [...counts.values()].reduce((sum, count) => sum + count, 0)
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(`::error::Missing ${BASELINE_PATH}.`)
    return 1
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = collectCurrentCounts(root)
  const { grown, shrunk } = diffCounts(current, baseline)
  for (const { file, now, allowed } of grown) {
    console.error(
      `::error file=${file}::${now} focus-routed call(s), baseline allows ${allowed}. Route by the resource's owner (resolveOwner + callHostRoute) instead of the Active Server setting.`
    )
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(
      `::error file=${file}::${now} focus-routed call(s), baseline still allows ${allowed}. Run: pnpm check:owner-routing-ratchet --prune`
    )
  }
  if (grown.length > 0 || shrunk.length > 0) {
    return 1
  }
  console.log(`Owner-routing ratchet OK — ${total(current)} focus-routed call site(s).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  if (process.argv[2] === '--prune') {
    const baselineFile = path.join(root, BASELINE_PATH)
    const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
    const current = collectCurrentCounts(root)
    // Lowers entries only; growth still has to be fixed in the code.
    const pruned = new Map(
      [...baseline].map(([file, allowed]) => [file, Math.min(allowed, current.get(file) ?? 0)])
    )
    fs.writeFileSync(baselineFile, formatBaseline(pruned))
    console.log(`Pruned ${BASELINE_PATH} to ${total(pruned)} call site(s).`)
    process.exit(main(root))
  }
  process.exit(main(root))
}
