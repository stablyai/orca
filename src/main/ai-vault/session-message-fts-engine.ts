import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'fts5-sql-bundle'

// Why: node:sqlite has ENABLE_FTS5=0, and stock sql.js WASM also omits FTS5.
// fts5-sql-bundle is a sql.js-compatible WASM build with FTS5+trigram and no
// native Electron rebuild. Agent dirs stay read-only; we persist our own file.

let sqlJsPromise: Promise<SqlJsStatic> | null = null

export async function loadAiVaultSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs()
  }
  return sqlJsPromise
}

export async function openAiVaultSqlJsDatabase(dbPath: string): Promise<Database> {
  const SQL = await loadAiVaultSqlJs()
  try {
    const bytes = await readFile(dbPath)
    return new SQL.Database(bytes)
  } catch (error) {
    // Why: only a missing file is a first-run empty index. Other read/parse
    // errors must not persist an empty replacement over a real DB.
    if (isMissingIndexFile(error)) {
      return new SQL.Database()
    }
    throw error
  }
}

function isMissingIndexFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export async function persistAiVaultSqlJsDatabase(db: Database, dbPath: string): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true })
  await writeFile(dbPath, Buffer.from(db.export()))
}
