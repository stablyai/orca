import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { UNIT_INCLUDE } from './ci-unit-files.mjs'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
// Keyed by checkout, since worktrees can share one node_modules.
const CACHE_FILE = join(
  root,
  'node_modules',
  '.cache',
  `orca-vitest-sqlite-runtime-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`
)
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/
const SQLITE_HARNESSES = new Set([
  'persistence-test-harness',
  'agent-session-record-store-test-harness',
  'structured-agent-session-rest-test-rig',
  'journal-host-database-test-support',
  'terminal-topology-profile-fixture',
  'acknowledged-terminal-tab-retirement-fixture'
])
export const SQLITE_MODULES = [
  'src/main/sqlite/sync-database',
  'src/main/persistence/profile-state/profile-state-sqlite-authority',
  'src/main/native-chat/agent-session-journal/journal-host-database',
  'src/main/runtime/orchestration/db',
  'src/main/runtime/orchestration/db/orchestration-db',
  'src/main/runtime/structured-agent-session-runtime',
  'src/main/runtime/agent-session-record-store-slot'
]
const SQLITE_MODULE_PATHS = new Set(SQLITE_MODULES.map((module) => resolve(root, module)))
// A cheap superset of the parse below; a bare 'db' would match nearly every file.
const SQLITE_MODULE_NAMES = [
  ...SQLITE_HARNESSES,
  ...SQLITE_MODULES.map((module) => basename(module))
].filter((name) => name !== 'db')
const DB_MODULE_SPECIFIER = /\/db(?:\.[cm]?[jt]sx?)?['"]/

function namesSqliteModule(source) {
  return (
    SQLITE_MODULE_NAMES.some((name) => source.includes(name)) || DB_MODULE_SPECIFIER.test(source)
  )
}

/** Type-only names do not erase a default binding or an empty import's side effects. */
export function importsSqliteRuntime(file, source) {
  if (!namesSqliteModule(source)) {
    return false
  }
  // Loaded on demand so a warm cache skips the compiler entirely.
  const ts = require('typescript-api')
  const module = ts.createSourceFile(file, source, ts.ScriptTarget.Latest)
  return module.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return false
    }
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (
      clause?.isTypeOnly ||
      (!clause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((name) => name.isTypeOnly))
    ) {
      return false
    }
    const specifier = statement.moduleSpecifier.text.replace(SOURCE_EXTENSION, '')
    return (
      SQLITE_HARNESSES.has(basename(specifier)) ||
      SQLITE_MODULE_PATHS.has(resolve(root, dirname(file), specifier))
    )
  })
}

function readCache(version) {
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    return cache.version === version && cache.files && typeof cache.files === 'object'
      ? cache.files
      : {}
  } catch {
    return {}
  }
}

function walkFiles(directory, files) {
  let entries
  try {
    entries = readdirSync(resolve(root, directory), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`
    if (!entry.isDirectory()) {
      files.push(path)
    } else if (entry.name !== 'node_modules' && entry.name !== '.git') {
      // Vitest's defaultExclude, pruned instead of matched per file.
      walkFiles(path, files)
    }
  }
}

/** UNIT_INCLUDE files as repo-relative paths; a plain walk is several times faster than fs.globSync. */
export function listUnitTestFiles() {
  const files = []
  for (const base of new Set(UNIT_INCLUDE.map((pattern) => pattern.split('/**')[0]))) {
    walkFiles(base, files)
  }
  return files.filter((file) => UNIT_INCLUDE.some((pattern) => posix.matchesGlob(file, pattern)))
}

// Match Vitest's case-insensitive path substrings, also stripping :line so the scan never misses selected tests.
export function matchesRunFilter(file, filters) {
  const testFile = file.toLowerCase()
  const absolute = resolve(root, file).replaceAll('\\', '/')
  return filters.some((raw) =>
    [raw, raw.replace(/(?::\d+)+$/, '')].some((filter) => {
      const slashed = filter.replaceAll('\\', '/')
      const relativePath = relative(process.cwd(), filter).replaceAll('\\', '/')
      return (
        (isAbsolute(filter) && absolute.startsWith(slashed)) ||
        testFile.includes(slashed.toLowerCase()) ||
        testFile.includes(relativePath.toLowerCase())
      )
    })
  )
}

// Classify direct SQLite/harness imports only among tests the CLI filters can select.
export function findSqliteRuntimeTests({ filters } = {}) {
  // Reuse unchanged verdicts; full test-source scan costs about a second.
  const version = createHash('sha256')
    .update(readFileSync(import.meta.filename))
    .digest('hex')
  const cached = readCache(version)
  const scoped = Boolean(filters?.length)
  const candidates = listUnitTestFiles()
  const files = {}
  let changed = false
  for (const path of scoped
    ? candidates.filter((file) => matchesRunFilter(file, filters))
    : candidates) {
    const { mtimeMs, size } = statSync(resolve(root, path))
    const entry = cached[path]
    if (
      Array.isArray(entry) &&
      entry[0] === mtimeMs &&
      entry[1] === size &&
      typeof entry[2] === 'boolean'
    ) {
      files[path] = entry
      continue
    }
    files[path] = [
      mtimeMs,
      size,
      importsSqliteRuntime(path, readFileSync(resolve(root, path), 'utf8'))
    ]
    changed = true
  }
  if (changed || (!scoped && Object.keys(cached).length !== Object.keys(files).length)) {
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true })
      const temporary = `${CACHE_FILE}.${process.pid}`
      // Only a full scan knows which files were deleted; a scoped one keeps verdicts it skipped.
      const merged = scoped ? { ...cached, ...files } : files
      writeFileSync(temporary, JSON.stringify({ version, files: merged }))
      // Atomic whole-file rename prevents concurrent runs from exposing partial cache.
      renameSync(temporary, CACHE_FILE)
    } catch {
      // The cache only saves time; the verdicts above are already complete.
    }
  }
  return Object.keys(files)
    .filter((path) => files[path][2])
    .sort()
}
