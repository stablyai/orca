import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { isOpenCodeV2DatabaseName } from '../../shared/opencode-database-name'
import { resolveOpenCodeStorageDirectory } from '../opencode/opencode-data-directory'
import { listOpenCodeDatabases } from '../opencode-usage/scanner'
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

export function opencodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const storageDirs = opencodeStorageDirs(options, wslHomeDirs)
  return storageDirs.flatMap((storageDir, index) => {
    const pathsPromise = opencodeDbPathsForSource(options, wslHomeDirs, storageDir, index)
    return [
      pathsPromise.then(({ v1Paths }) =>
        discoverOpenCodeSessions({
          storageDir,
          dbPaths: v1Paths,
          limitPerAgent: limit,
          issues
        })
      ),
      pathsPromise.then(({ v2Paths }) =>
        v2Paths.length > 0
          ? discoverOpenCode2Sessions(storageDir, v2Paths, limit, issues)
          : Promise.resolve(emptyOpenCode2Discovery(storageDir))
      )
    ]
  })
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
  sourceIndex: number
): Promise<{ v1Paths: string[]; v2Paths: string[] }> {
  if (options.opencodeDbPaths) {
    return splitDatabasePaths(sourceIndex === 0 ? options.opencodeDbPaths : [])
  }
  // Why: custom OpenCode storage roots still keep SQLite DBs in the parent data dir.
  if (sourceIndex === 0 && options.opencodeStorageDir) {
    return splitDatabasePaths(await listOpenCodeDatabasesInDirectory(dirname(storageDir)))
  }
  if (sourceIndex === 0) {
    return splitDatabasePaths(await listOpenCodeDatabases())
  }
  const wslHomeDir = wslHomeDirs[sourceIndex - 1]
  return wslHomeDir
    ? splitDatabasePaths(
        await listOpenCodeDatabasesInDirectory(join(wslHomeDir, '.local', 'share', 'opencode'))
      )
    : { v1Paths: [], v2Paths: [] }
}

async function listOpenCodeDatabasesInDirectory(dataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(dataDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(dataDir, entry.name))
      .sort()
  } catch {
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

function emptyOpenCode2Discovery(storageDir: string): SessionFileDiscovery {
  return {
    agent: 'opencode2' as const,
    rootDir: storageDir,
    files: []
  }
}
