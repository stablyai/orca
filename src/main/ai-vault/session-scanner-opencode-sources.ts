import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { listOpenCodeDatabases } from '../opencode-usage/scanner'
import { discoverOpenCodeSessions } from './session-scanner-opencode-sqlite-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

const OPENCODE_STORAGE_DIR = join(
  process.env.OPENCODE_CONFIG_DIR?.trim() || join(homedir(), '.local', 'share', 'opencode'),
  'storage'
)

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
      dbPaths: await opencodeDbPathsForSource(options, wslHomeDirs, storageDir, index),
      limitPerAgent: limit,
      issues
    })
  )
}

function opencodeStorageDirs(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): string[] {
  return [
    options.opencodeStorageDir ?? OPENCODE_STORAGE_DIR,
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.local', 'share', 'opencode', 'storage'))
  ]
}

async function opencodeDbPathsForSource(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  storageDir: string,
  sourceIndex: number
): Promise<readonly string[]> {
  if (options.opencodeDbPaths) {
    return sourceIndex === 0 ? options.opencodeDbPaths : []
  }
  // Why: custom OpenCode storage roots still keep SQLite DBs in the parent data dir.
  if (sourceIndex === 0 && options.opencodeStorageDir) {
    return listOpenCodeDatabasesInDirectory(dirname(storageDir))
  }
  if (sourceIndex === 0) {
    return listOpenCodeDatabases()
  }
  const wslHomeDir = wslHomeDirs[sourceIndex - 1]
  return wslHomeDir
    ? listOpenCodeDatabasesInDirectory(join(wslHomeDir, '.local', 'share', 'opencode'))
    : []
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
