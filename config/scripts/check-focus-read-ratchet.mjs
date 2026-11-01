import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  diffCounts,
  parseCountBaseline,
  pruneCountBaseline,
  readTrackedSources,
  totalCount
} from './ratchet-baseline.mjs'

// Count direct Active Server reads and discovered caller-returning wrappers so changing syntax cannot hide host-misrouting growth.
// Route work by resource host; counts only decrease, and deleted helpers stay banned.

const SCAN_ROOT = 'src/renderer/src'
const BASELINE_PATH = 'config/focus-setting-read-baseline.txt'
const FORBIDDEN_HELPERS = [
  'getActiveRuntimeTarget',
  'legacyRouteFromSettings',
  'settingsForRuntimeOwner'
]
const IMPORT_EXPORT_LIST = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g
// Calls and value uses (`.map(helper)`); definitions and type queries are not routing.
const FORBIDDEN_HELPER_USE = new RegExp(
  `(?<!(?:function|typeof)\\s+)\\b(?:${FORBIDDEN_HELPERS.join('|')})\\b`,
  'g'
)
// Seed readers; every function that reads the setting or calls a reader joins them by discovery.
// The sanctioned readers are seeds too: their bodies reach the setting through a private helper.
const SEED_FOCUS_READERS = [
  ...FORBIDDEN_HELPERS,
  'defaultCreationHost',
  'defaultScopeHost',
  'defaultScopeSource',
  'rowLessSourceTarget'
]
const FOCUS_SCAN_ROOTS = [SCAN_ROOT, 'src/shared']

/** Imports and re-exports are not uses; an aliased one is reported by {@link hasFocusRoutingAlias}. */
export function countForbiddenHelperUses(sourceText) {
  return sourceText.replace(IMPORT_EXPORT_LIST, '').match(FORBIDDEN_HELPER_USE)?.length ?? 0
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

// Follow returned values until bracket-free newline; skip object bags or store/slice exports pull in the whole graph.
const VALUE_STATEMENT_START = /\breturn\s+(?!\(?\s*\{)|=>\s*(?!\(?\s*\{)/g

function statementsFrom(body, start) {
  const statements = []
  for (const match of body.matchAll(start)) {
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
      } else if (depth === 0 && (char === '\n' || (char === ',' && match[0].startsWith('=>')))) {
        break
      }
    }
    statements.push({ name: match[1], text: body.slice(match.index, end) })
  }
  return statements
}

// `const id = reader(…)` counts only when `id` is then returned (assign-then-return).
const LOCAL_ASSIGNMENT_START = /\b(?:const|let)\s+([\w$]+)\s*(?::[^=\n]*)?=(?![=>])/g

function valueStatements(body) {
  const returned = statementsFrom(body, VALUE_STATEMENT_START).map(({ text }) => text)
  const returnedIds = new Set(returned.join('\n').match(/[\w$]+/g))
  const assigned = statementsFrom(body, LOCAL_ASSIGNMENT_START)
    .filter(({ name }) => returnedIds.has(name))
    .map(({ text }) => text)
  return [...returned, ...assigned].join('\n')
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

// Discover exported setting readers and returned-reader wrappers to a fixpoint, keyed by defining file.
// Hand lists miss renamed copies; following every call instead of returned values pulls in most renderer code through the store.
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

const BASELINE_HEADER = [
  '# Renderer reads of the Active Server setting (member, element and destructuring reads of',
  '# activeRuntimeEnvironmentId) plus calls of exported functions that read it, per file.',
  '# This is a RATCHET: counts may only go DOWN. Only creation flows with no source row may read',
  '# the default host, through defaultCreationHost. Everything else routes by the owner.',
  '# Prune after removing reads: pnpm check:focus-read-ratchet --prune'
]
const ADVICE =
  "Route by the resource's owner. Only a creation flow with no source row may use defaultCreationHost."

// Why test support too: harnesses and fixtures seed settings for tests; they never route host work.
const TEST_SUPPORT_PATH =
  /(?:\.(?:test|spec)(?:-fixture|-support)?|-test-(?:harness|fixtures?))\.tsx?$/

export function isScannedPath(rel) {
  return /\.(ts|tsx)$/.test(rel) && !TEST_SUPPORT_PATH.test(rel)
}

// One read and one discovery per root per run; `--prune` then `main` reuse them.
const scanCache = new Map()

function scanSources(root) {
  if (!scanCache.has(root)) {
    const sources = readTrackedSources(root, FOCUS_SCAN_ROOTS, isScannedPath)
    scanCache.set(root, { sources, readers: discoverFocusReaders(sources) })
  }
  return scanCache.get(root)
}

export function collectCurrentCounts(root = process.cwd()) {
  const { sources, readers } = scanSources(root)
  const counts = new Map()
  const forbidden = []
  const aliased = []
  for (const [rel, source] of sources) {
    if (!rel.startsWith(`${SCAN_ROOT}/`)) {
      continue
    }
    const found = countFocusSettingReads(source, readers.namesFor(rel), readers.memberNames)
    if (found > 0) {
      counts.set(rel, found)
    }
    if (countForbiddenHelperUses(source) > 0) {
      forbidden.push(rel)
    }
    if (hasFocusRoutingAlias(source)) {
      aliased.push(rel)
    }
  }
  return { counts, forbidden, aliased }
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(`::error::Missing ${BASELINE_PATH}.`)
    return 1
  }
  const { counts: current, forbidden, aliased } = collectCurrentCounts(root)
  for (const file of forbidden) {
    console.error(
      `::error file=${file}::${FORBIDDEN_HELPERS.join(', ')} are deleted focus-routing helpers; do not reintroduce them. ${ADVICE}`
    )
  }
  for (const file of aliased) {
    console.error(
      `::error file=${file}::A focus reader is imported or exported under another name, which hides its calls from this ratchet. Use the original name.`
    )
  }
  const { grown, shrunk } = diffCounts(
    current,
    parseCountBaseline(fs.readFileSync(baselineFile, 'utf8'))
  )
  for (const { file, now, allowed } of grown) {
    console.error(
      `::error file=${file}::${now} focus read(s), baseline allows ${allowed}. ${ADVICE}`
    )
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(
      `::error file=${file}::${now} focus read(s), baseline still allows ${allowed}. Run: pnpm check:focus-read-ratchet --prune`
    )
  }
  if (forbidden.length + aliased.length + grown.length + shrunk.length > 0) {
    return 1
  }
  console.log(`Focus-read ratchet OK — ${totalCount(current)} read(s).`)
  return 0
}

export function prune(root = process.cwd()) {
  const { counts: current } = collectCurrentCounts(root)
  const kept = pruneCountBaseline(root, BASELINE_PATH, BASELINE_HEADER, current)
  console.log(`Pruned ${BASELINE_PATH} to ${kept} read(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  if (process.argv[2] === '--prune') {
    prune(root)
  }
  process.exit(main(root))
}
