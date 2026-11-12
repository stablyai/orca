import { basename, delimiter, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { wslGatedAccess } from '../../../native-chat/wsl-transcript-fs-access'
import { discoverFiles } from '../../session-scanner-discovery'
import { AI_VAULT_AGENT_SOURCES } from '../../session-scanner-agent-sources'
import {
  listHermesSqliteSessionIds,
  listHermesSqliteSessions
} from './session-scanner-hermes-sqlite'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from '../../session-scanner-types'
import { scopeWalksAgentFiles } from '../../session-scope-cwd'
import { throwIfAiVaultScanCancelled } from '../../ai-vault-scan-cancellation'

/**
 * Resolves existing Hermes state.db file paths across host and WSL environments.
 * Gated rather than a raw existsSync: a stalled 9P mount would hang the scan.
 */
async function hermesStateDbPaths(
  options: AiVaultScanOptions,
  rootDirs: readonly string[]
): Promise<string[]> {
  if (options.hermesStateDbPaths) {
    return [...options.hermesStateDbPaths]
  }
  const candidateDbPaths = rootDirs.map((rootDir) => join(dirname(rootDir), 'state.db'))
  const probedDbPaths = await Promise.all(
    candidateDbPaths.map((dbPath) =>
      wslGatedAccess(dbPath, 'scan', options.signal).then(
        (exists) => (exists ? dbPath : null),
        () => {
          throwIfAiVaultScanCancelled(options.signal)
          return null
        }
      )
    )
  )
  return probedDbPaths.filter((dbPath): dbPath is string => dbPath !== null)
}

/**
 * Discover Hermes sessions from both legacy JSON files (`session_*.json`) and
 * the SQLite database (`state.db`), deduplicating at the file level.
 * Legacy JSON files whose session ID matches a SQLite entry are dropped in favor
 * of the SQLite database as the source of truth.
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
  const source = AI_VAULT_AGENT_SOURCES.hermes
  const rootDirs = source.rootDirs(options, wslHomeDirs)
  const walksScope = scopeWalksAgentFiles('hermes', options.scopePaths)

  const fileDiscoveryPromises = rootDirs.map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'hermes',
      issues,
      extensions: [...source.extensions],
      filePredicate: source.filePredicate,
      keepScopeFiles: walksScope,
      signal: options.signal
    })
  )

  const sqlitePromise = hermesStateDbPaths(options, rootDirs).then(async (dbPaths) => {
    const list = (scopePaths?: readonly string[]) =>
      listHermesSqliteSessions({ dbPaths, limit, issues, scopePaths })
    const [candidates, scopeCandidates] = await Promise.all([
      list(),
      walksScope ? list(options.scopePaths) : undefined
    ])
    return { candidates, scopeCandidates, sessionIds: await listHermesSqliteSessionIds(dbPaths) }
  })

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
        const scopeFiles = walksScope
          ? [
              ...fileResults.flatMap((res) => (res.scopeFiles ?? []).filter(isLegacyOnly)),
              ...(sqlite.scopeCandidates ?? []).map((candidate) => candidate.file)
            ]
          : undefined

        return {
          agent: 'hermes' as const,
          rootDir: rootDirs.join(delimiter),
          files: [...allFiles, ...sqliteFiles],
          ...(scopeFiles ? { scopeFiles } : {})
        }
      }
    )
  ]
}
