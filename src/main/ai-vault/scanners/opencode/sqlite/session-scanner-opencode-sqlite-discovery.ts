import { basename, dirname, extname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import { discoverFiles } from '../../../discovery/session-scanner-discovery'
import { splitOpenCodeSqliteCandidate } from '../../../../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import {
  listForHost,
  listOpenCodeSqliteSessionsViaWorker
} from '../reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import { wslGatedAccess } from '../../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { isMissingTranscriptPathError } from '../../../discovery/session-path-absence'
import {
  recordSessionScanIssue,
  scanIssueTextFromError
} from '../../../parsing/session-scan-issues'
import { throwIfAiVaultScanCancelled } from '../../../scan-lifecycle/ai-vault-scan-cancellation'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from '../../../session-scanner-types'
import { scopeOnlyScan, scopeWalksAgentFiles } from '../../../scope/session-scope-cwd'

export async function discoverStandaloneSqliteSessions(
  agent: 'zcode' | 'devin',
  dbPath: string,
  options: AiVaultScanOptions,
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  const rootDir = agent === 'devin' ? dirname(dbPath) : dbPath
  const sqliteContainer = agent === 'devin' ? { path: dbPath, fullyEnumerated: false } : undefined
  const empty = { agent, rootDir, files: [], sqliteContainer }
  try {
    if (!(await wslGatedAccess(dbPath, 'scan', options.signal))) {
      return empty
    }
  } catch (error) {
    throwIfAiVaultScanCancelled(options.signal)
    if (!isMissingTranscriptPathError(error)) {
      recordSessionScanIssue(issues, {
        agent,
        kind: 'scope',
        path: dbPath,
        ...scanIssueTextFromError(error)
      })
    }
    return empty
  }
  const dbIssues: AiVaultScanIssue[] = []
  const skipRecent = agent === 'devin' && scopeOnlyScan(options)
  const list = (scopePaths?: readonly string[]) =>
    listForHost({
      agent,
      dbPaths: [dbPath],
      limit,
      issues: dbIssues,
      scopePaths,
      signal: options.signal
    }).then((candidates) => candidates.map(({ file }) => file))
  const [files, scopeFiles] = await Promise.all([
    skipRecent ? [] : list(),
    scopeWalksAgentFiles(agent, options.scopePaths) ? list(options.scopePaths) : undefined
  ])
  for (const issue of dbIssues) {
    recordSessionScanIssue(issues, issue)
  }
  if (sqliteContainer) {
    sqliteContainer.fullyEnumerated = !skipRecent && limit === Infinity && dbIssues.length === 0
  }
  return { ...empty, files, ...(scopeFiles ? { scopeFiles } : {}) }
}

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
  statCache?: AiVaultScanOptions['statCache']
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  const walksScope = scopeWalksAgentFiles('opencode', args.scopePaths)
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
      statCache: args.statCache,
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
    ...(scopeFiles ? { scopeFiles } : {})
  }
}
