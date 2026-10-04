import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { wslGatedAccess } from '../native-chat/wsl-transcript-fs-access'
import { listZcodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

// ZCode's CLI stores its OpenCode-shaped history in a separate database.
// Keep discovery separate so an OpenCode install cannot absorb ZCode rows.
export function zcodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const paths = options.zcodeDbPath
    ? [options.zcodeDbPath]
    : [homedir(), ...wslHomeDirs].map((home) => join(home, '.zcode', 'cli', 'db', 'db.sqlite'))
  return paths.map(async (dbPath) => ({
    agent: 'zcode' as const,
    rootDir: dbPath,
    files: (await zcodeDatabaseExists(dbPath, issues, options.signal))
      ? (
          await listZcodeSqliteSessionsViaWorker({
            dbPaths: [dbPath],
            limit,
            issues,
            signal: options.signal
          })
        ).map((candidate) => candidate.file)
      : []
  }))
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
      message: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}
