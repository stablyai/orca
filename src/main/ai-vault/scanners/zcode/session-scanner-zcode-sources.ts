import { discoverSessionContainer } from '../../session-discovery-context'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { throwIfSignalAborted } from '../../../../shared/abort-signal-reason'
import { wslGatedAccess } from '../../../native-chat/wsl-transcript-fs-access'
import { listZcodeSqliteSessionsViaWorker } from '../opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import { scanIssueTextFromError } from '../../session-scan-issues'
import type { AiVaultScanOptions, SessionFileDiscovery } from '../../session-scanner-types'
import { scopeWalksAgentFiles } from '../../session-scope-cwd'

// Keep ZCode discovery separate so OpenCode cannot absorb its database rows.
export function zcodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const paths = options.zcodeDbPath
    ? [options.zcodeDbPath]
    : [homedir(), ...wslHomeDirs].map((home) => join(home, '.zcode', 'cli', 'db', 'db.sqlite'))
  return paths.map(async (dbPath) => {
    if (!(await zcodeDatabaseExists(dbPath, issues, options.signal))) {
      return discoverSessionContainer(
        `zcode:${dbPath}`,
        [dbPath],
        async () => ({
          agent: 'zcode',
          rootDir: dbPath,
          files: [],
          complete: !issues.some((issue) => issue.path === dbPath && issue.kind !== 'notice')
        }),
        limit,
        issues
      )
    }
    const list = (
      scopePaths?: readonly string[],
      paths: readonly string[] = [dbPath],
      count = limit,
      requestIssues = issues
    ) =>
      listZcodeSqliteSessionsViaWorker({
        dbPaths: paths,
        limit: count,
        issues: requestIssues,
        scopePaths,
        signal: options.signal
      }).then((candidates) => candidates.map((candidate) => candidate.file))
    const [discovery, scopeFiles] = await Promise.all([
      discoverSessionContainer(
        `zcode:${dbPath}`,
        [dbPath],
        async (paths, count) => {
          const requestIssues: AiVaultScanIssue[] = []
          const files = await list(undefined, paths, count, requestIssues)
          issues.push(...requestIssues)
          return {
            agent: 'zcode',
            rootDir: dbPath,
            files,
            complete: !requestIssues.some((issue) => issue.kind !== 'notice')
          }
        },
        limit,
        issues
      ),
      scopeWalksAgentFiles('zcode', options.scopePaths) ? list(options.scopePaths) : undefined
    ])
    return {
      agent: 'zcode' as const,
      sourceOrder: discovery.sourceOrder,
      rootDir: dbPath,
      files: discovery.files,
      ...(scopeFiles ? { scopeFiles } : {})
    }
  })
}

async function zcodeDatabaseExists(
  dbPath: string,
  issues: AiVaultScanIssue[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    return await wslGatedAccess(dbPath, 'scan', signal)
  } catch (error) {
    throwIfSignalAborted(signal)
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    issues.push({
      agent: 'zcode',
      path: dbPath,
      ...scanIssueTextFromError(error)
    })
    return false
  }
}
