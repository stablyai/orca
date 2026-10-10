import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Two ratchets for renderer code that routes host-owned work by the "Active Server" setting
// instead of by the resource's own host. Per-file counts may only go down.
// - Owner routing: the three focus-routing helpers, counted together so renaming one into another
//   never lowers the count.
// - Focus reads: every read of the setting, including the helpers and `defaultCreationHost`, so
//   swapping a helper for a direct read or for the creation default never lowers it either.

const SCAN_ROOT = 'src/renderer/src'
const HELPER_NAMES = 'getActiveRuntimeTarget|legacyRouteFromSettings|settingsForRuntimeOwner'
const HELPERS = `(?:${HELPER_NAMES})`
const IMPORT_EXPORT_LIST = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g
// Calls and value uses (`.map(helper)`); definitions and type queries are not routing.
const FOCUS_ROUTING_USE = new RegExp(`(?<!(?:function|typeof)\\s+)\\b${HELPERS}\\b`, 'g')
const FOCUS_ROUTING_ALIAS = new RegExp(`\\b(?:${HELPER_NAMES}|defaultCreationHost)\\s+as\\b`)
const FOCUS_SETTING_READ = /\??\.activeRuntimeEnvironmentId\b/g
const DEFAULT_CREATION_HOST_USE = /(?<!(?:function|typeof)\s+)\bdefaultCreationHost\b/g

/** Imports and re-exports are not uses; an aliased one is reported by {@link hasFocusRoutingAlias}. */
export function countFocusRoutingCalls(sourceText) {
  return sourceText.replace(IMPORT_EXPORT_LIST, '').match(FOCUS_ROUTING_USE)?.length ?? 0
}

/** Member reads of the setting plus every helper that reads it on the caller's behalf. */
export function countFocusSettingReads(sourceText) {
  const body = sourceText.replace(IMPORT_EXPORT_LIST, '')
  return (
    (body.match(FOCUS_SETTING_READ)?.length ?? 0) +
    (body.match(DEFAULT_CREATION_HOST_USE)?.length ?? 0) +
    countFocusRoutingCalls(sourceText)
  )
}

/** An alias hides later calls from the count, so it is refused outright. */
export function hasFocusRoutingAlias(sourceText) {
  return (sourceText.match(IMPORT_EXPORT_LIST) ?? []).some((list) => FOCUS_ROUTING_ALIAS.test(list))
}

export const RATCHETS = [
  {
    name: 'owner-routing',
    baselinePath: 'config/owner-routing-baseline.txt',
    count: countFocusRoutingCalls,
    header: [
      '# Renderer call sites that route by the Active Server focus setting:',
      '# getActiveRuntimeTarget( + legacyRouteFromSettings( + settingsForRuntimeOwner(, per file.',
      '# This is a RATCHET: counts may only go DOWN. Route new work by the resource owner instead.',
      '# Prune after removing sites: pnpm check:owner-routing-ratchet --prune'
    ],
    advice:
      "Route by the resource's owner (resolveOwner + callHostRoute) instead of the Active Server setting."
  },
  {
    name: 'focus-setting-read',
    baselinePath: 'config/focus-setting-read-baseline.txt',
    count: countFocusSettingReads,
    header: [
      '# Renderer reads of the Active Server setting (`.activeRuntimeEnvironmentId`), the',
      '# focus-routing helpers and defaultCreationHost(, per file.',
      '# This is a RATCHET: counts may only go DOWN. Only creation flows with no source row may read',
      '# the default host, through defaultCreationHost. Everything else routes by the owner.',
      '# Prune after removing reads: pnpm check:owner-routing-ratchet --prune'
    ],
    advice:
      "Route by the resource's owner. Only a creation flow with no source row may use defaultCreationHost."
  }
]

export function isScannedPath(rel) {
  return /\.(ts|tsx)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel)
}

/** `<count> <path> [# note]` lines; `#` comment lines and blanks ignored. */
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

/** Trailing `# note` per row, so a pruned baseline keeps why an entry is still allowed. */
export function parseBaselineNotes(text) {
  const notes = new Map()
  for (const raw of text.split('\n')) {
    const match = /^\s*\d+\s+(\S+)\s+#\s*(.+?)\s*$/.exec(raw)
    if (match) {
      notes.set(match[1], match[2])
    }
  }
  return notes
}

export function formatBaseline(counts, header = RATCHETS[0].header, notes = new Map()) {
  const rows = [...counts]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, count]) =>
      notes.has(file) ? `${count} ${file} # ${notes.get(file)}` : `${count} ${file}`
    )
  return `${[...header, ''].join('\n')}${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`
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

export function collectCurrentCounts(root = process.cwd(), count = countFocusRoutingCalls) {
  const tracked = execFileSync('git', ['ls-files', SCAN_ROOT], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter((rel) => rel && isScannedPath(rel))
  const counts = new Map()
  const aliased = []
  for (const rel of tracked) {
    let source
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const found = count(source)
    if (found > 0) {
      counts.set(rel, found)
    }
    if (hasFocusRoutingAlias(source)) {
      aliased.push(rel)
    }
  }
  return { counts, aliased }
}

function total(counts) {
  return [...counts.values()].reduce((sum, count) => sum + count, 0)
}

function checkRatchet(root, ratchet) {
  const baselineFile = path.join(root, ratchet.baselinePath)
  if (!fs.existsSync(baselineFile)) {
    console.error(`::error::Missing ${ratchet.baselinePath}.`)
    return { ok: false, total: 0 }
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const { counts: current } = collectCurrentCounts(root, ratchet.count)
  const { grown, shrunk } = diffCounts(current, baseline)
  for (const { file, now, allowed } of grown) {
    console.error(
      `::error file=${file}::${ratchet.name}: ${now} use(s), baseline allows ${allowed}. ${ratchet.advice}`
    )
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(
      `::error file=${file}::${ratchet.name}: ${now} use(s), baseline still allows ${allowed}. Run: pnpm check:owner-routing-ratchet --prune`
    )
  }
  return { ok: grown.length === 0 && shrunk.length === 0, total: total(current) }
}

export function main(root = process.cwd()) {
  const { aliased } = collectCurrentCounts(root)
  for (const file of aliased) {
    console.error(
      `::error file=${file}::A focus-routing helper is imported or exported under another name, which hides its calls from this ratchet. Use the original name.`
    )
  }
  let ok = aliased.length === 0
  for (const ratchet of RATCHETS) {
    const result = checkRatchet(root, ratchet)
    ok = ok && result.ok
    if (result.ok) {
      console.log(`${ratchet.name} ratchet OK — ${result.total} use(s).`)
    }
  }
  return ok ? 0 : 1
}

export function prune(root = process.cwd()) {
  for (const ratchet of RATCHETS) {
    const baselineFile = path.join(root, ratchet.baselinePath)
    const text = fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf8') : ''
    const baseline = parseBaseline(text)
    const { counts: current } = collectCurrentCounts(root, ratchet.count)
    // Lowers entries only; growth still has to be fixed in the code.
    const pruned = new Map(
      [...baseline].map(([file, allowed]) => [file, Math.min(allowed, current.get(file) ?? 0)])
    )
    fs.writeFileSync(baselineFile, formatBaseline(pruned, ratchet.header, parseBaselineNotes(text)))
    console.log(`Pruned ${ratchet.baselinePath} to ${total(pruned)} use(s).`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  if (process.argv[2] === '--prune') {
    prune(root)
  }
  process.exit(main(root))
}
