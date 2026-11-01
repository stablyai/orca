import { basename, extname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { scopeWalksAgentFiles } from './session-scope-cwd'
import { isSelectedSessionFile } from './session-scanner-selection'

export { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'

function sessionIdFromLegacyFilePath(filePath: string): string {
  return basename(filePath, extname(filePath))
}

/** Prefer SQLite candidates over stale legacy files sharing a session ID, before parsing either. */
export async function discoverOpenCodeSessions(args: {
  storageDir: string
  dbPaths: readonly string[]
  limitPerAgent: number
  issues: AiVaultScanIssue[]
  selectedSessionId?: string
  scopePaths?: readonly string[]
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  const walksScope = scopeWalksAgentFiles('opencode', args.scopePaths)
  const listSqlite = (scopePaths?: readonly string[]) =>
    listOpenCodeSqliteSessionsViaWorker({
      dbPaths: args.dbPaths,
      limit: args.limitPerAgent,
      issues: args.issues,
      scopePaths,
      selectedSessionId: args.selectedSessionId,
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
      selectedSessionId: args.selectedSessionId,
      signal: args.signal
    }),
    listSqlite(),
    walksScope ? listSqlite(args.scopePaths) : undefined
  ])

  const sqliteFiles = sqliteCandidates.map((c) => c.file)
  const sqliteScopeFiles = sqliteScopeCandidates?.map((c) => c.file)
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
    selectedFiles: [
      ...withoutSqliteDuplicates(fileDiscovery.selectedFiles ?? []),
      ...sqliteFiles.filter((file) =>
        isSelectedSessionFile(args.selectedSessionId, 'opencode', file.path)
      )
    ],
    ...(scopeFiles ? { scopeFiles } : {})
  }
}
