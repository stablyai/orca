import {
  currentSessionDiscovery,
  discoverSessionContainer
} from '../../../session-discovery-context'
import { basename, extname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import { discoverFiles } from '../../../session-scanner-discovery'
import { splitOpenCodeSqliteCandidate } from '../../../../../shared/opencode-sqlite-session-path'
import { listOpenCodeSqliteSessionsViaWorker } from '../reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import type { FileWithMtime, SessionFileDiscovery } from '../../../session-scanner-types'
import { scopeWalksAgentFiles } from '../../../session-scope-cwd'

function sessionIdFromLegacyFilePath(filePath: string): string {
  return basename(filePath, extname(filePath))
}

/** Prefer SQLite candidates over stale legacy files sharing a session ID, before parsing either. */
export async function discoverOpenCodeSessions(args: {
  storageDir: string
  dbPaths: readonly string[]
  limitPerAgent: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
  signal?: AbortSignal
  enumerationComplete?: boolean
}): Promise<SessionFileDiscovery> {
  const rootDir = join(args.storageDir, 'session')
  const walksScope = scopeWalksAgentFiles('opencode', args.scopePaths)
  const listSqlite = (
    scopePaths?: readonly string[],
    dbPaths = args.dbPaths,
    limit = args.limitPerAgent,
    requestIssues = args.issues
  ) =>
    listOpenCodeSqliteSessionsViaWorker({
      dbPaths,
      limit,
      issues: requestIssues,
      scopePaths,
      signal: args.signal
    })
  const [fileDiscovery, sqliteDiscovery, sqliteScopeCandidates] = await Promise.all([
    discoverFiles({
      rootDir,
      limit: args.limitPerAgent,
      agent: 'opencode',
      issues: args.issues,
      extensions: ['.json'],
      searchDependencies: [
        {
          path: join(args.storageDir, 'message'),
          eventsOnly: true,
          fileKey: (path) => sessionIdFromLegacyFilePath(path),
          eventKey: (path) =>
            path.slice(join(args.storageDir, 'message').length + 1).split(/[\\/]/)[0] ?? null
        }
      ],
      keepScopeFiles: walksScope,
      signal: args.signal
    }),
    discoverSessionContainer(
      `opencode:${args.storageDir}`,
      args.dbPaths,
      async (paths, limit) => {
        const requestIssues: AiVaultScanIssue[] = []
        const candidates = await listSqlite(undefined, paths, limit, requestIssues)
        args.issues.push(...requestIssues)
        return {
          agent: 'opencode',
          rootDir,
          files: candidates.map((candidate) => candidate.file),
          complete: !requestIssues.some((issue) => issue.kind !== 'notice')
        }
      },
      args.limitPerAgent,
      args.issues,
      args.enumerationComplete
    ),
    walksScope ? listSqlite(args.scopePaths) : undefined
  ])

  const sqliteFiles = sqliteDiscovery.files
  const sqliteScopeFiles = sqliteScopeCandidates?.map((c) => c.file)
  const sqliteSessionIds = new Set<string>()
  for (const file of [...sqliteFiles, ...(sqliteScopeFiles ?? [])]) {
    const parsed = splitOpenCodeSqliteCandidate(file.path)
    if (parsed) {
      if (sqliteSessionIds instanceof Set) {
        sqliteSessionIds.add(parsed.sessionId)
      }
    }
  }
  const withoutSqliteDuplicates = (files: readonly FileWithMtime[]): FileWithMtime[] =>
    files.filter((file) => !sqliteSessionIds.has(sessionIdFromLegacyFilePath(file.path)))
  const scopeFiles = walksScope
    ? [...withoutSqliteDuplicates(fileDiscovery.scopeFiles ?? []), ...(sqliteScopeFiles ?? [])]
    : undefined

  return {
    agent: 'opencode' as const,
    sourceOrder: sqliteDiscovery.sourceOrder,
    rootDir: fileDiscovery.rootDir,
    files: [
      ...(currentSessionDiscovery()
        ? fileDiscovery.files
        : withoutSqliteDuplicates(fileDiscovery.files)),
      ...sqliteFiles
    ],
    ...(scopeFiles ? { scopeFiles } : {})
  }
}
