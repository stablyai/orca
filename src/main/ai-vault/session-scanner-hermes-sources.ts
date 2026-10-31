import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedAccess } from '../native-chat/wsl-transcript-fs-access'
import { discoverFiles } from './session-scanner-discovery'
import {
  listHermesSqliteSessionIds,
  listHermesSqliteSessions
} from './session-scanner-hermes-sqlite'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'
import { sessionRootDirs } from './session-scanner-roots'
import { scopeWalksAgentFiles } from './session-scope-cwd'

const HERMES_SESSIONS_DIR = join(homedir(), '.hermes', 'sessions')

/**
 * Resolves existing Hermes state.db file paths across host and WSL environments.
 * Gated rather than a raw existsSync: a stalled 9P mount would hang the scan.
 */
async function hermesStateDbPaths(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): Promise<string[]> {
  if (options.hermesStateDbPaths) {
    return [...options.hermesStateDbPaths]
  }
  const mainDir = options.hermesSessionsDir
    ? dirname(options.hermesSessionsDir)
    : join(homedir(), '.hermes')
  const candidateDbPaths = [
    join(mainDir, 'state.db'),
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.hermes', 'state.db'))
  ]
  const probedDbPaths = await Promise.all(
    candidateDbPaths.map((dbPath) =>
      wslGatedAccess(dbPath, 'scan').then(
        () => dbPath,
        () => null
      )
    )
  )
  return probedDbPaths.filter((dbPath): dbPath is string => dbPath !== null)
}

/**
 * Discover Hermes sessions from both legacy JSON files (`session_*.json`) and
 * the SQLite database (`state.db`), deduplicating at the file level.
 * Legacy JSON files whose session ID matches a SQLite entry are dropped in favor
 * of the SQLite database as the source of truth on 0.19+.
 * @param options - AI Vault scan options.
 * @param wslHomeDirs - Normalized WSL home directory paths.
 * @param limit - Maximum number of sessions per source.
 * @param issues - Collected scan issues.
 * @returns Array of promises resolving to `SessionFileDiscovery`.
 */
export function hermesDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const rootDirs = sessionRootDirs(options.hermesSessionsDir ?? HERMES_SESSIONS_DIR, wslHomeDirs, [
    '.hermes',
    'sessions'
  ])

  const fileDiscoveryPromises = rootDirs.map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'hermes',
      issues,
      extensions: ['.json'],
      filePredicate: (path) => basename(path).startsWith('session_'),
      keepScopeFiles: scopeWalksAgentFiles('hermes', options.scopePaths),
      signal: options.signal
    })
  )

  const sqlitePromise = hermesStateDbPaths(options, wslHomeDirs).then(async (dbPaths) => ({
    candidates: await listHermesSqliteSessions({ dbPaths, limit, issues }),
    sessionIds: listHermesSqliteSessionIds(dbPaths)
  }))

  return [
    Promise.all([Promise.all(fileDiscoveryPromises), sqlitePromise]).then(
      ([fileResults, sqlite]) => {
        const sqliteFiles = sqlite.candidates.map((c) => c.file)

        const isLegacyOnly = (file: FileWithMtime): boolean => {
          const name = basename(file.path, '.json')
          const sessionId = name.startsWith('session_') ? name.slice(8) : name
          return !sqlite.sessionIds.has(sessionId)
        }
        const allFiles = fileResults.flatMap((res) => res.files.filter(isLegacyOnly))
        const scopeFiles = fileResults.some((res) => res.scopeFiles)
          ? fileResults.flatMap((res) => (res.scopeFiles ?? []).filter(isLegacyOnly))
          : undefined

        return {
          agent: 'hermes' as const,
          rootDir: fileResults[0]?.rootDir ?? HERMES_SESSIONS_DIR,
          files: [...allFiles, ...sqliteFiles],
          ...(scopeFiles ? { scopeFiles } : {})
        }
      }
    )
  ]
}
