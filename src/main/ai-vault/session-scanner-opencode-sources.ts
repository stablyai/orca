import { delimiter, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { resolveOpenCodeStorageDirectory } from '../opencode/opencode-data-directory'
import { listOpenCodeDatabases } from '../opencode-usage/opencode-database-discovery'
import { recordSessionScanIssue } from './session-scan-issues'
import { discoverOpenCodeSessions } from './session-scanner-opencode-sqlite-discovery'
import { listOpenCodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'
import { resolveMimocodeDirectories } from '../mimo/mimocode-directories'

export function opencodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const storageDirs = opencodeStorageDirs(options, wslHomeDirs)
  return storageDirs.map(async (storageDir, index) =>
    discoverOpenCodeSessions({
      storageDir,
      dbPaths: await opencodeDbPathsForSource(options, wslHomeDirs, storageDir, index, issues),
      limitPerAgent: limit,
      issues
    })
  )
}

export function mimoCodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const configuredMimocodeHome = process.env.MIMOCODE_HOME?.trim() || undefined
  const localDataDir = resolveMimocodeDirectories(configuredMimocodeHome, process.env).data
  const dbPaths = options.mimoCodeDbPaths ?? [
    join(localDataDir, 'mimocode.db'),
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.local', 'share', 'mimocode', 'mimocode.db'))
  ]
  return [
    listOpenCodeSqliteSessionsViaWorker({ dbPaths, limit, issues, agent: 'mimo-code' }).then(
      (candidates) => ({
        agent: 'mimo-code',
        rootDir: dbPaths.map(dirname).join(delimiter),
        files: candidates.map((candidate) => candidate.file)
      })
    )
  ]
}

function opencodeStorageDirs(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): string[] {
  return [
    options.opencodeStorageDir ?? resolveOpenCodeStorageDirectory(),
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.local', 'share', 'opencode', 'storage'))
  ]
}

async function opencodeDbPathsForSource(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  storageDir: string,
  sourceIndex: number,
  issues: AiVaultScanIssue[]
): Promise<readonly string[]> {
  if (options.opencodeDbPaths) {
    return sourceIndex === 0 ? options.opencodeDbPaths : []
  }
  // Why: custom OpenCode storage roots still keep SQLite DBs in the parent data dir.
  if (sourceIndex === 0 && options.opencodeStorageDir) {
    return listOpenCodeDatabasesInDirectory(dirname(storageDir), issues)
  }
  if (sourceIndex === 0) {
    return listOpenCodeDatabases((path, error) => {
      recordSessionScanIssue(issues, { agent: 'opencode', path, message: error.message })
    })
  }
  const wslHomeDir = wslHomeDirs[sourceIndex - 1]
  return wslHomeDir
    ? listOpenCodeDatabasesInDirectory(join(wslHomeDir, '.local', 'share', 'opencode'), issues)
    : []
}

async function listOpenCodeDatabasesInDirectory(
  dataDir: string,
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  try {
    const entries = await wslGatedReaddir(dataDir, 'scan')
    return entries
      .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(dataDir, entry.name))
      .sort()
  } catch (error) {
    // A stalled WSL data dir still degrades to "no databases", but the gap has
    // to be reportable — an empty list otherwise reads as "OpenCode not used".
    if (error instanceof WslTranscriptFsError) {
      recordSessionScanIssue(issues, { agent: 'opencode', path: dataDir, message: error.message })
    }
    return []
  }
}
