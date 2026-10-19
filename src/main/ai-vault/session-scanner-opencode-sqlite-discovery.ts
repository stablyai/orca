import { basename, extname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { scopeWalksAgentFiles } from './session-scope-cwd'

// Why: keep the SQLite discovery + dedup layer separate from the parser so
// each file stays under the max-lines lint rule and the discovery layer can
// be tested in isolation. The SQLite list query + reader now lives in
// session-scanner-opencode-sqlite-list.ts (re-exported below so existing
// callers/tests keep importing it from here) and runs on a worker thread.

// Re-exported: the pure list reader moved to its own electron-free module so the
// worker entry can import it without the worker client's Electron dependency.
export { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'

// Why: extract the sessionId from a legacy file path like
// storage/session/<projectId>/<sessionId>.json. Falls back to the filename
// without extension when the opencode id format doesn't match a UUID.
function sessionIdFromLegacyFilePath(filePath: string): string {
  return basename(filePath, extname(filePath))
}

/**
 * Discover OpenCode sessions from both the legacy file layout and the SQLite
 * DB, deduplicating at the file level before parsing. On mixed installs the
 * same session may appear once via a stale legacy JSON file and once via the
 * SQLite DB; SQLite is the source of truth on 1.17.x, so file-based entries
 * whose sessionId matches a SQLite entry are dropped. Legacy installs without
 * the `session` table fall through to the file scanner unchanged.
 * @param args.storageDir - Root of the OpenCode storage directory (contains `session/` and `message/`).
 * @param args.dbPaths - Absolute paths to opencode.db files to scan.
 * @param args.limitPerAgent - Maximum number of candidates per source.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns A `SessionFileDiscovery` with deduplicated file entries.
 */
export async function discoverOpenCodeSessions(args: {
  storageDir: string
  dbPaths: readonly string[]
  limitPerAgent: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  const walksScope = scopeWalksAgentFiles('opencode', args.scopePaths)
  // Why (#8864): the SQLite list leg runs on a worker thread; only this leg
  // moves off the main thread, the filesystem scan stays inline.
  const listSqlite = (scopePaths?: readonly string[]) =>
    listOpenCodeSqliteSessionsViaWorker({
      dbPaths: args.dbPaths,
      limit: args.limitPerAgent,
      issues: args.issues,
      scopePaths,
      signal: args.signal
    })
  const [fileDiscovery, sqliteCandidates, sqliteScopeCandidates] = await Promise.all([
    discoverFiles({
      rootDir: join(args.storageDir, 'session'),
      limit: args.limitPerAgent,
      agent: 'opencode',
      issues: args.issues,
      extensions: ['.json'],
      keepScopeFiles: walksScope,
      signal: args.signal
    }),
    listSqlite(),
    walksScope ? listSqlite(args.scopePaths) : undefined
  ])

  const sqliteFiles = sqliteCandidates.map((c) => c.file)
  const sqliteScopeFiles = sqliteScopeCandidates?.map((c) => c.file)
  // Why: on mixed installs the same OpenCode session may appear once via the
  // SQLite DB and once via a stale legacy JSON file. SQLite is the source of
  // truth on 1.17.x, so drop file-based duplicates when a SQLite entry with
  // the same sessionId already exists. Deduping at the file level also avoids
  // parsing the same session twice.
  const sqliteSessionIds = new Set<string>()
  for (const file of [...sqliteFiles, ...(sqliteScopeFiles ?? [])]) {
    const parsed = splitOpenCodeSqliteCandidate(file.path)
    if (parsed) {
      sqliteSessionIds.add(parsed.sessionId)
    }
  }
  const withoutSqliteDuplicates = (files: readonly FileWithMtime[]): FileWithMtime[] =>
    files.filter((file) => !sqliteSessionIds.has(sessionIdFromLegacyFilePath(file.path)))
  const scopeFiles = walksScope
    ? [...withoutSqliteDuplicates(fileDiscovery.scopeFiles ?? []), ...(sqliteScopeFiles ?? [])]
    : undefined

  return {
    agent: 'opencode' as const,
    rootDir: fileDiscovery.rootDir,
    files: [...withoutSqliteDuplicates(fileDiscovery.files), ...sqliteFiles],
    ...(scopeFiles ? { scopeFiles } : {})
  }
}
