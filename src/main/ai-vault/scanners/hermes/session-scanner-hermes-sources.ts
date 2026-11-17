import { listHermesSqliteSessionsViaWorker } from './session-scanner-hermes-worker'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { throwIfSignalAborted } from '../../../../shared/concurrency/abort-signal-reason'
import { getHermesHome } from '../../../hermes/hermes-default-home'
import {
  HERMES_PROFILE_NAME,
  hermesProfileRoot
} from '../../../../shared/agent-launch/startup/hermes-profile'
import {
  wslGatedAccess,
  wslGatedReaddir
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { isMissingTranscriptPathError } from '../../discovery/session-path-absence'
import { scanIssueTextFromError } from '../../parsing/session-scan-issues'
import { scopeWalksAgentFiles } from '../../scope/session-scope-cwd'
import type { AiVaultScanOptions, SessionFileDiscovery } from '../../session-scanner-types'

// Hermes keeps every surface's sessions in one state.db per profile: the root's own and profiles/<name>/.

async function profileHomes(
  home: string,
  issues: AiVaultScanIssue[],
  signal?: AbortSignal
): Promise<string[]> {
  const profilesDir = join(home, 'profiles')
  try {
    const entries = await wslGatedReaddir(profilesDir, 'scan', signal)
    return entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          entry.name !== 'default' &&
          HERMES_PROFILE_NAME.test(entry.name)
      )
      .map((entry) => join(profilesDir, entry.name))
      .sort()
  } catch (error) {
    throwIfSignalAborted(signal)
    if (!isMissingTranscriptPathError(error)) {
      issues.push({ agent: 'hermes', path: profilesDir, ...scanIssueTextFromError(error) })
    }
    return []
  }
}

async function databaseExists(
  dbPath: string,
  issues: AiVaultScanIssue[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    return await wslGatedAccess(dbPath, 'scan', signal)
  } catch (error) {
    throwIfSignalAborted(signal)
    if (!isMissingTranscriptPathError(error)) {
      issues.push({ agent: 'hermes', path: dbPath, ...scanIssueTextFromError(error) })
    }
    return false
  }
}

export function hermesDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const homes = [
    // HERMES_HOME may name a profile; its siblings and the root are the same install.
    hermesProfileRoot(options.hermesHome ?? getHermesHome()),
    ...wslHomeDirs.map((home) => join(home, '.hermes'))
  ]
  return homes.map(async (home) => {
    const databases = [home, ...(await profileHomes(home, issues, options.signal))].map((profile) =>
      join(profile, 'state.db')
    )
    const present = (
      await Promise.all(
        databases.map(async (dbPath) =>
          (await databaseExists(dbPath, issues, options.signal)) ? dbPath : null
        )
      )
    ).filter((dbPath): dbPath is string => dbPath !== null)
    const list = (scopePaths?: readonly string[]) =>
      present.length === 0
        ? Promise.resolve([])
        : listHermesSqliteSessionsViaWorker({
            dbPaths: present,
            limit,
            issues,
            scopePaths,
            signal: options.signal
          }).then((candidates) => candidates.slice(0, limit).map((candidate) => candidate.file))
    const [files, scopeFiles] = await Promise.all([
      list(),
      scopeWalksAgentFiles('hermes', options.scopePaths) ? list(options.scopePaths) : undefined
    ])
    return {
      agent: 'hermes' as const,
      rootDir: home,
      files,
      ...(scopeFiles ? { scopeFiles } : {})
    }
  })
}
