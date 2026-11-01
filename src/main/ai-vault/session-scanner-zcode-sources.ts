import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { wslGatedAccess } from '../native-chat/wsl-transcript-fs-access'
import { listZcodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import { scanIssueTextFromError } from './session-scan-issues'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'
import { scopeWalksAgentFiles } from './session-scope-cwd'
import { isSelectedSessionFile } from './session-scanner-selection'

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
      return { agent: 'zcode' as const, rootDir: dbPath, files: [] }
    }
    const list = (scopePaths?: readonly string[]) =>
      listZcodeSqliteSessionsViaWorker({
        dbPaths: [dbPath],
        limit,
        issues,
        scopePaths,
        selectedSessionId: options.selectedSessionId,
        signal: options.signal
      }).then((candidates) => candidates.map((candidate) => candidate.file))
    const [files, scopeFiles] = await Promise.all([
      list(),
      scopeWalksAgentFiles('zcode', options.scopePaths) ? list(options.scopePaths) : undefined
    ])
    return {
      agent: 'zcode' as const,
      rootDir: dbPath,
      files,
      selectedFiles: files.filter((file) =>
        isSelectedSessionFile(options.selectedSessionId, 'zcode', file.path)
      ),
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
