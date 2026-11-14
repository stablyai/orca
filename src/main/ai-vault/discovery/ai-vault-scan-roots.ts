import { join } from 'node:path'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { claudeProfileHistoryDirs } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { getCachedWslDistros, hasCachedWslDistros } from '../../wsl/discovery/distro-catalog'
import {
  listLastKnownRunningWslHomeDirs,
  readRunningWslHomeDirsUnlessStopped
} from '../../wsl/discovery/wsl-home-unless-stopped'
import { filterPathsToRunningWslDistrosAsync } from '../../wsl/filesystem/wsl-running-path-filter'
import type { AiVaultScanOptions } from '../session-scanner-types'
import { managedOpenCodeAccountDataDirs } from '../../opencode/accounts/opencode-managed-account-data-dirs'
import { antigravityChatBrainDir } from '../../antigravity/antigravity-chat-home'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { prepareOpenCodeWslReaders } from '../scanners/opencode/reader-transport/opencode-wsl-runtime-preparation'

// Configure sources through the runtime service; headless serve never runs window-only IPC registration.
export type AiVaultSessionSources = {
  getAdditionalCodexHomePaths?: () => readonly string[]
}

let sources: AiVaultSessionSources = {}

export function configureAiVaultSessionSources(next: AiVaultSessionSources): void {
  sources = next
}

export function resetAiVaultSessionSourcesForTests(): void {
  sources = {}
}

type LocalAiVaultScanRoots = Required<
  Pick<AiVaultScanOptions, 'additionalCodexSessionsDirs' | 'wslHomeDirs'>
> &
  Pick<
    AiVaultScanOptions,
    | 'executionHostId'
    | 'wslOpenCodeReaders'
    | 'claudeProfileProjectsDirs'
    | 'opencodeAccountDataDirs'
    | 'antigravityChatBrainDir'
  >

/** Resolve fresh WSL roots for both listing and indexing; distros can start or stop between scans. */
export async function localAiVaultScanRoots(): Promise<LocalAiVaultScanRoots> {
  return (await resolveLocalAiVaultScanRoots()).roots
}

/** `wslConfirmed` is false when no confirmed running list was read: WSL rows are then unknown, not gone. */
export async function resolveLocalAiVaultScanRoots(): Promise<{
  roots: LocalAiVaultScanRoots
  wslConfirmed: boolean
}> {
  const [additionalCodexHomes, wsl] = await Promise.all([
    // Confirmed only: a stale list could name a distro that stopped; a failed probe drops WSL homes.
    filterPathsToRunningWslDistrosAsync(configuredAdditionalCodexHomePaths(), {
      requireConfirmed: true
    }).catch(() => configuredAdditionalCodexHomePaths().filter((home) => !isWslUncPath(home))),
    scanWslHomeDirs()
  ])
  return {
    wslConfirmed: wsl.confirmed,
    roots: {
      additionalCodexSessionsDirs: additionalCodexHomes.map((homePath) =>
        join(homePath, 'sessions')
      ),
      wslHomeDirs: wsl.homes,
      // Scanner workers have no account router; supply profile roots from this process.
      claudeProfileProjectsDirs: claudeProfileHistoryDirs('projects'),
      opencodeAccountDataDirs: managedOpenCodeAccountDataDirs(),
      // The chat host's state root, as structured-session-account-home resolves it.
      antigravityChatBrainDir: antigravityChatBrainDir(getProfileUserDataPath()),
      wslOpenCodeReaders: await prepareOpenCodeWslReaders(wsl.homes),
      // Runtime-addressed callers restamp host-local results at the RPC edge instead of rescanning.
      executionHostId: LOCAL_EXECUTION_HOST_ID
    }
  }
}

/** Resume validation must use the same extra Codex homes that discovery lists. */
export function configuredAdditionalCodexHomePaths(): readonly string[] {
  return sources.getAdditionalCodexHomePaths?.() ?? []
}

/** Trust cached absence of any distro; otherwise a confirmed running list (E9). */
async function scanWslHomeDirs(): Promise<{ homes: string[]; confirmed: boolean }> {
  if (
    process.platform !== 'win32' ||
    (hasCachedWslDistros() && getCachedWslDistros()?.length === 0)
  ) {
    return { homes: [], confirmed: true }
  }
  return readRunningWslHomeDirsUnlessStopped()
}

/** WSL homes for work that reads inside them: a stopped distro's home is absent, not refused. */
export async function getAiVaultWslScanHomeDirs(): Promise<string[]> {
  return (await scanWslHomeDirs()).homes
}

/**
 * WSL roots for checking a path a user act names (delete, subagent listing): a containment check
 * reads nothing, so a failed probe must not narrow them and keeps the last-known-good list.
 */
export async function getAiVaultWslHomeDirs(): Promise<string[]> {
  if (
    process.platform !== 'win32' ||
    (hasCachedWslDistros() && getCachedWslDistros()?.length === 0)
  ) {
    return []
  }
  return listLastKnownRunningWslHomeDirs()
}
