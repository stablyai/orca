import { createHash } from 'node:crypto'
import { globSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { defaultExclude } from 'vitest/config'
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
  'journal-host-database-test-support'
])
export const SQLITE_MODULES = [
  'src/main/sqlite/sync-database',
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

/** Unit tests that load Node SQLite through a direct import, as repo-relative paths. */
export function findSqliteRuntimeTests() {
  // Why: reading every test costs about a second; unchanged files reuse their last verdict.
  const version = createHash('sha256')
    .update(readFileSync(import.meta.filename))
    .digest('hex')
  const cached = readCache(version)
  const files = {}
  let changed = false
  for (const file of globSync(UNIT_INCLUDE, { cwd: root, exclude: defaultExclude })) {
    const path = file.replaceAll('\\', '/')
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
  if (changed || Object.keys(cached).length !== Object.keys(files).length) {
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true })
      const temporary = `${CACHE_FILE}.${process.pid}`
      writeFileSync(temporary, JSON.stringify({ version, files }))
      // Why: parallel runs each rename a whole file, so a reader never sees a partial write.
      renameSync(temporary, CACHE_FILE)
    } catch {
      // The cache only saves time; the verdicts above are already complete.
    }
  }
  return Object.keys(files)
    .filter((path) => files[path][2])
    .sort()
}
