import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { listHermesSqliteSessions } from './session-scanner-hermes-sqlite'
import { splitHermesSqliteCandidate } from './session-scanner-hermes-sqlite-paths'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'

const HERMES_SESSIONS_DIR = join(homedir(), '.hermes', 'sessions')

function sessionRootDirs(
  hostRootDir: string,
  wslHomeDirs: readonly string[],
  segments: readonly string[]
): string[] {
  return [hostRootDir, ...wslHomeDirs.map((homeDir) => join(homeDir, ...segments))]
}

function hermesStateDbPaths(options: AiVaultScanOptions, wslHomeDirs: readonly string[]): string[] {
  if (options.hermesStateDbPaths) {
    return [...options.hermesStateDbPaths]
  }
  const mainDir = options.hermesSessionsDir
    ? dirname(options.hermesSessionsDir)
    : join(homedir(), '.hermes')
  return [
    join(mainDir, 'state.db'),
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.hermes', 'state.db'))
  ]
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
      filePredicate: (path) => basename(path).startsWith('session_')
    })
  )

  const dbPaths = hermesStateDbPaths(options, wslHomeDirs)
  const sqlitePromise = listHermesSqliteSessions({ dbPaths, limit, issues })

  return [
    Promise.all([Promise.all(fileDiscoveryPromises), sqlitePromise]).then(
      ([fileResults, sqliteCandidates]) => {
        const sqliteFiles = sqliteCandidates.map((c) => c.file)
        const sqliteSessionIds = new Set<string>()
        for (const file of sqliteFiles) {
          const parsed = splitHermesSqliteCandidate(file.path)
          if (parsed) {
            sqliteSessionIds.add(parsed.sessionId)
          }
        }

        // Why: collect all legacy JSON session files across all root dirs (local & WSL)
        // and filter out any that are duplicated in the SQLite database.
        const allFiles: FileWithMtime[] = []
        for (const res of fileResults) {
          for (const file of res.files) {
            const name = basename(file.path, '.json')
            const sessionId = name.startsWith('session_') ? name.slice(8) : name
            if (!sqliteSessionIds.has(sessionId)) {
              allFiles.push(file)
            }
          }
        }
        allFiles.push(...sqliteFiles)

        return {
          agent: 'hermes' as const,
          rootDir: fileResults[0]?.rootDir ?? HERMES_SESSIONS_DIR,
          files: allFiles
        }
      }
    )
  ]
}
