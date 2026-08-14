import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { isOpenCodeV2DatabaseName } from '../../shared/opencode-database-name'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { resolveOpenCodeStorageDirectory } from '../opencode/opencode-data-directory'
import { listOpenCodeDatabases } from '../opencode-usage/scanner'
import { recordSessionScanIssue } from './session-scan-issues'
import { discoverOpenCodeSessions } from './session-scanner-opencode-sqlite-discovery'
import { listOpenCode2SqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

// Why: opencode2's channel-scoped DBs share the v1 `opencode*.db` glob but not
// its schema — split by basename so each discovery only sees its own store.

function splitDatabasePaths(dbPaths: readonly string[]): {
  v1Paths: string[]
  v2Paths: string[]
} {
  const v1Paths: string[] = []
  const v2Paths: string[] = []
  for (const dbPath of dbPaths) {
    if (isOpenCodeV2DatabaseName(basename(dbPath))) {
      v2Paths.push(dbPath)
    } else {
      v1Paths.push(dbPath)
    }
  }
  return { v1Paths, v2Paths }
}

export async function opencodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery[]> {
  const storageDirs = opencodeStorageDirs(options, wslHomeDirs)
  const discoveriesByDir = await Promise.all(
    storageDirs.map(async (storageDir, index) => {
      const paths = await opencodeDbPathsForSource(options, wslHomeDirs, storageDir, index, issues)
      const { v1Paths, v2Paths } = splitDatabasePaths(paths)
      const v1 = await discoverOpenCodeSessions({
        storageDir,
        dbPaths: v1Paths,
        limitPerAgent: limit,
        issues
      })
      // Why: keep one discovery per dir for v1-only installs (existing callers
      // count them); only add the opencode2 leg when v2 DBs actually exist.
      if (v2Paths.length === 0) {
        return [v1]
      }
      const v2 = await discoverOpenCode2Sessions(storageDir, v2Paths, limit, issues)
      return [v1, v2]
    })
  )
  return discoveriesByDir.flat()
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
      recordSessionScanIssue(issues, {
        agent: 'opencode',
        path: dataDir,
        message: error.message
      })
    }
    return []
  }
}

async function discoverOpenCode2Sessions(
  storageDir: string,
  dbPaths: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  const files = await listOpenCode2SqliteSessionsViaWorker({ dbPaths, limit, issues })
  return {
    agent: 'opencode2' as const,
    rootDir: storageDir,
    files: files.map((candidate) => candidate.file)
  }
}
