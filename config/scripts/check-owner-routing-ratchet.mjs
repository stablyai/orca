import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Two ratchets for renderer code that routes host-owned work by the "Active Server" setting
// instead of by the resource's own host. Per-file counts may only go down.
// - Owner routing: the three focus-routing helpers, counted together so renaming one into another
//   never lowers the count.
// - Focus reads: every read of the setting plus every call of an exported function that reads it
//   for the caller (discovered, not hand-listed), so swapping one form for another never lowers it.

const SCAN_ROOT = 'src/renderer/src'
const HELPER_NAMES = 'getActiveRuntimeTarget|legacyRouteFromSettings|settingsForRuntimeOwner'
const HELPERS = `(?:${HELPER_NAMES})`
const IMPORT_EXPORT_LIST = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g
// Calls and value uses (`.map(helper)`); definitions and type queries are not routing.
const FOCUS_ROUTING_USE = new RegExp(`(?<!(?:function|typeof)\\s+)\\b${HELPERS}\\b`, 'g')
// Seed readers; every function that reads the setting or calls a reader joins them by discovery.
const SEED_FOCUS_READERS = [...HELPER_NAMES.split('|'), 'defaultCreationHost']
const FOCUS_SCAN_ROOTS = [SCAN_ROOT, 'src/shared']

/** Imports and re-exports are not uses; an aliased one is reported by {@link hasFocusRoutingAlias}. */
export function countFocusRoutingCalls(sourceText) {
  return sourceText.replace(IMPORT_EXPORT_LIST, '').match(FOCUS_ROUTING_USE)?.length ?? 0
}

// Element reads after a PascalCase name or `>` are indexed types (`GlobalSettings['…']`), not reads.
const SETTING_MEMBER_READ =
  /\??\.\s*activeRuntimeEnvironmentId\b|(?<!(?:\b[A-Z][\w$]*|>)\s*)\[\s*['"]activeRuntimeEnvironmentId['"]\s*\]/g
// `const { activeRuntimeEnvironmentId } = s`, `{ activeRuntimeEnvironmentId: id }: T = s` or nested
// `{ settings: { activeRuntimeEnvironmentId } } = state`; object literals and `({ … }) =>`
// parameters are not reads of the setting.
const SETTING_DESTRUCTURE_READ =
  /\{[^{}]*\bactiveRuntimeEnvironmentId\b[^{}]*\}(?:\s*\})*\s*(?::[^=;{}]*)?=(?![=>])/g
// A top-level declaration: `[export] [async] function name` or `[export] const|let name =`.
const TOP_LEVEL_DECLARATION =
  /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([\w$]+)|(?:const|let)\s+([\w$]+)\b)/gm
// Any new statement at column 0 ends a declaration; closing brackets and continuations do not.
const TOP_LEVEL_BOUNDARY = /^[^\s)}\]]/gm

// Member calls only, so dotted string keys (`'auto.hooks.useX.abc'`) are not uses.
const MEMBER_NAME = /\.\s*([\w$]+)\s*(?:\?\.\s*)?\(/g

function readerUsePattern(names) {
  return names.size === 0
    ? null
    : new RegExp(
        `(?<!(?:function|typeof|const|let)\\s*\\*?\\s+)\\b(?:${[...names].join('|')})\\b`,
        'g'
      )
}

function countSettingReads(body) {
  return (
    (body.match(SETTING_MEMBER_READ)?.length ?? 0) +
    (body.match(SETTING_DESTRUCTURE_READ)?.length ?? 0)
  )
}

/** Top-level declarations with their source text, up to the next top-level statement. */
export function topLevelDeclarations(sourceText) {
  const boundaries = [...sourceText.matchAll(TOP_LEVEL_BOUNDARY)].map((match) => match.index)
  return [...sourceText.matchAll(TOP_LEVEL_DECLARATION)].map((match) => {
    const end = boundaries.find((index) => index > match.index) ?? sourceText.length
    return {
      name: match[2] ?? match[3],
      exported: Boolean(match[1]),
      text: sourceText.slice(match.index, end)
    }
  })
}

// Statements that hand a value on: `return …` or an arrow's expression body, each running to the
// first newline outside brackets. Object-literal results (`=> ({ … })`, `return { … }`) are
// skipped: slice creators and hooks return bags of actions, which pulls in the whole store.
const VALUE_STATEMENT_START = /\breturn\s+(?!\(?\s*\{)|=>\s*(?!\(?\s*\{)/g

function valueStatements(body) {
  const statements = []
  for (const match of body.matchAll(VALUE_STATEMENT_START)) {
    let depth = 0
    let end = match.index + match[0].length
    for (; end < body.length; end += 1) {
      const char = body[end]
      if ('([{'.includes(char)) {
        depth += 1
      } else if (')]}'.includes(char)) {
        if (depth === 0) {
          break
        }
        depth -= 1
      } else if (char === '\n' && depth === 0) {
        break
      }
    }
    statements.push(body.slice(match.index, end))
  }
  return statements.join('\n')
}

const IMPORT_STATEMENT =
  /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const REEXPORT_STATEMENT = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
// `const { reader } = (await import('…'))` and `import('…').then(({ reader }) =>` bind like a
// named import; `{ reader: local }` renames like `as`.
const DYNAMIC_IMPORT_DESTRUCTURE =
  /\{([^{}]*)\}\s*=\s*\(?\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\))?/g
const DYNAMIC_IMPORT_THEN =
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)\s*\.then\(\s*(?:async\s*)?\(\s*\{([^{}]*)\}/g
const STAR_REEXPORT_STATEMENT = /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g
const LOCAL_EXPORT_LIST = /\bexport\s+\{([^}]*)\}(?!\s*from)/g

function specifiers(list) {
  return list
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => {
      const [imported, local = imported] = part.split(/\s+as\s+|\s*:\s*/)
      return { imported: imported.trim(), local: local.trim() }
    })
}

function resolveModule(spec, fromRel, files) {
  let base
  if (spec.startsWith('@/')) {
    base = `${SCAN_ROOT}/${spec.slice(2)}`
  } else if (spec.startsWith('.')) {
    base = path.posix.join(path.posix.dirname(fromRel), spec)
  } else {
    return null
  }
  base = base.replace(/\.(?:m?js|tsx?)$/, '')
  return (
    ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find((c) => files.has(c)) ??
    null
  )
}

function parseModule(rel, text, files) {
  const imports = new Map()
  for (const [, list, spec] of [
    ...text.matchAll(IMPORT_STATEMENT),
    ...text.matchAll(DYNAMIC_IMPORT_DESTRUCTURE),
    ...[...text.matchAll(DYNAMIC_IMPORT_THEN)].map(([all, from, names]) => [all, names, from])
  ]) {
    const from = resolveModule(spec, rel, files)
    for (const { imported, local } of specifiers(list)) {
      imports.set(local, { from, name: imported })
    }
  }
  const reexports = new Map()
  for (const [, list, spec] of text.matchAll(REEXPORT_STATEMENT)) {
    const from = resolveModule(spec, rel, files)
    for (const { imported, local } of specifiers(list)) {
      reexports.set(local, { from, name: imported })
    }
  }
  const starFrom = [...text.matchAll(STAR_REEXPORT_STATEMENT)].map(([, spec]) =>
    resolveModule(spec, rel, files)
  )
  const listed = new Map()
  for (const [, list] of text.matchAll(LOCAL_EXPORT_LIST)) {
    for (const { imported, local } of specifiers(list)) {
      listed.set(imported, local)
    }
  }
  const declarations = topLevelDeclarations(text.replace(IMPORT_EXPORT_LIST, '')).map((decl) => ({
    ...decl,
    exportedAs: decl.exported ? decl.name : (listed.get(decl.name) ?? null)
  }))
  return { imports, reexports, starFrom, declarations }
}

/**
 * Functions that read the setting for their caller, keyed by defining file so a same-named
 * function elsewhere (a test harness's `useAppStore`) is not mistaken for one. Seeds, then every
 * exported top-level function whose body reads the setting or calls a seed, then, to a fixpoint,
 * every one that returns a reader's result. Hand lists miss look-alikes such as a copy of
 * `getActiveRuntimeTarget` under another name; discovery does not. Following every call instead
 * of returned values pulls in most of the renderer through the store.
 */
export function discoverFocusReaders(sources) {
  const files = new Set(sources.keys())
  const modules = new Map([...sources].map(([rel, text]) => [rel, parseModule(rel, text, files)]))
  const seeds = new Set(SEED_FOCUS_READERS)
  const seedUse = readerUsePattern(seeds)
  const readerKeys = new Set()

  const resolveExport = (rel, name, depth = 0) => {
    const mod = rel ? modules.get(rel) : null
    if (!mod || depth > 8) {
      return null
    }
    if (mod.declarations.some((decl) => decl.exportedAs === name)) {
      return `${rel}#${name}`
    }
    const re = mod.reexports.get(name)
    if (re) {
      return resolveExport(re.from, re.name, depth + 1)
    }
    for (const from of mod.starFrom) {
      const key = resolveExport(from, name, depth + 1)
      if (key) {
        return key
      }
    }
    return null
  }
  const resolveLocal = (rel, name) => {
    const mod = modules.get(rel)
    if (mod.declarations.some((decl) => decl.exportedAs && decl.name === name)) {
      return `${rel}#${mod.declarations.find((decl) => decl.name === name).exportedAs}`
    }
    const imported = mod.imports.get(name)
    return imported ? resolveExport(imported.from, imported.name) : null
  }
  const isReader = (rel, name) => seeds.has(name) || readerKeys.has(resolveLocal(rel, name))

  const pending = []
  for (const [rel, mod] of modules) {
    for (const { name, exportedAs, text } of mod.declarations) {
      // Components render; a `<Pane />` that reads focus inside is not a read by its parent.
      if (!exportedAs || /^[A-Z]/.test(exportedAs)) {
        continue
      }
      seedUse.lastIndex = 0
      if (countSettingReads(text) > 0 || seedUse.test(text)) {
        readerKeys.add(`${rel}#${exportedAs}`)
        continue
      }
      const statements = valueStatements(text)
      const passed = new Set(statements.match(/[\w$]+/g))
      passed.delete(name)
      const members = [...statements.matchAll(MEMBER_NAME)].map(([, member]) => member)
      pending.push({ rel, key: `${rel}#${exportedAs}`, passed: [...passed], members })
    }
  }
  // Exported reader names, for `ns.reader(…)` through a namespace or dynamic import.
  const memberNames = new Set(seeds)
  const addReader = (key) => {
    readerKeys.add(key)
    memberNames.add(key.slice(key.indexOf('#') + 1))
  }
  for (const key of readerKeys) {
    addReader(key)
  }
  let changed = true
  while (changed) {
    changed = false
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const { rel, key, passed, members } = pending[i]
      if (
        passed.some((id) => isReader(rel, id)) ||
        members.some((member) => memberNames.has(member))
      ) {
        addReader(key)
        pending.splice(i, 1)
        changed = true
      }
    }
  }

  const namesByFile = new Map()
  return {
    has: (name) => memberNames.has(name),
    memberNames,
    /** Names that refer to a reader inside `rel`: seeds, its own readers and imported ones. */
    namesFor(rel) {
      if (!namesByFile.has(rel)) {
        const mod = modules.get(rel)
        const local = [
          ...(mod?.declarations.map((decl) => decl.name) ?? []),
          ...(mod?.imports.keys() ?? [])
        ]
        namesByFile.set(
          rel,
          new Set([...seeds, ...local.filter((name) => mod && isReader(rel, name))])
        )
      }
      return namesByFile.get(rel)
    }
  }
}

/**
 * Reads of the setting (member, element and destructuring reads) plus every use of a name that
 * refers to a reader. Object-literal keys are writes and are not counted.
 */
export function countFocusSettingReads(
  sourceText,
  readerNames = new Set(SEED_FOCUS_READERS),
  memberNames = new Set()
) {
  const body = sourceText
    .replace(IMPORT_EXPORT_LIST, '')
    // A placeholder, so a dangling `const` does not read as a declaration of the next call.
    .replace(DYNAMIC_IMPORT_DESTRUCTURE, 'dynamicImport')
    .replace(DYNAMIC_IMPORT_THEN, 'dynamicImport')
  const pattern = readerUsePattern(readerNames)
  // `ns.reader(…)` through a namespace or dynamic import; names already counted bare are skipped.
  const members = [...body.matchAll(MEMBER_NAME)].filter(
    ([, member]) => memberNames.has(member) && !readerNames.has(member)
  ).length
  return countSettingReads(body) + (pattern ? (body.match(pattern)?.length ?? 0) : 0) + members
}

/** An alias hides later calls from the name-based helper count, so it is refused outright. */
export function hasFocusRoutingAlias(sourceText) {
  const alias = new RegExp(`\\b(?:${SEED_FOCUS_READERS.join('|')})\\s+as\\b`)
  return (sourceText.match(IMPORT_EXPORT_LIST) ?? []).some((list) => alias.test(list))
}

export const RATCHETS = [
  {
    name: 'owner-routing',
    baselinePath: 'config/owner-routing-baseline.txt',
    count: (text) => countFocusRoutingCalls(text),
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
    count: (text, rel, readers) =>
      countFocusSettingReads(text, readers.namesFor(rel), readers.memberNames),
    header: [
      '# Renderer reads of the Active Server setting (member, element and destructuring reads of',
      '# activeRuntimeEnvironmentId) plus calls of exported functions that read it, per file.',
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

function readTrackedSources(root, scanRoot) {
  const tracked = execFileSync('git', ['ls-files', scanRoot], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter((rel) => rel && isScannedPath(rel))
  const sources = new Map()
  for (const rel of tracked) {
    try {
      sources.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'))
    } catch {
      // Deleted in the working tree but still tracked.
    }
  }
  return sources
}

// One read and one discovery per root per run; `--prune` then `main` reuse them.
const scanCache = new Map()

function scanSources(root) {
  if (!scanCache.has(root)) {
    const sources = new Map(
      FOCUS_SCAN_ROOTS.flatMap((scanRoot) => [...readTrackedSources(root, scanRoot)])
    )
    scanCache.set(root, { sources, readers: discoverFocusReaders(sources) })
  }
  return scanCache.get(root)
}

export function collectCurrentCounts(root = process.cwd(), count = RATCHETS[0].count) {
  const { sources, readers } = scanSources(root)
  const counts = new Map()
  const aliased = []
  for (const [rel, source] of sources) {
    if (!rel.startsWith(`${SCAN_ROOT}/`)) {
      continue
    }
    const found = count(source, rel, readers)
    if (found > 0) {
      counts.set(rel, found)
    }
    if (hasFocusRoutingAlias(source)) {
      aliased.push(rel)
    }
  }
  return { counts, aliased, readers }
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
