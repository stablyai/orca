import { isAbsolute, join } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import type { GitCapabilityCache } from '../../shared/git-capability-cache'
import { detectReliableDirectoryMtime } from '../../shared/git-performance-config-filesystem'
import {
  runGitPerformanceConfigAction,
  type GitPerformanceConfigHost
} from '../../shared/git-performance-config-runner'
import {
  normalizeGitTuningMode,
  type GitPerformanceConfigAction,
  type GitPerformanceConfigOptions,
  type GitTuningMode,
  type RepoPerformanceConfigOutcome
} from '../../shared/git-performance-config-types'
import { KeyedSerialRunner } from '../../shared/keyed-serial-runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { GitAdmissionTier } from './command-runner/git-exec-options'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { gitExecFileAsync } from './runner'

/**
 * Main-process entry for Orca's opt-in repository Git tuning. Native and WSL
 * repos run here; SSH repos run host-side on the relay, because that host's Git,
 * OS and filesystem decide every key.
 */

type PerformanceConfigRepo = Pick<Repo, 'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId'>
type GitTuningSettings = { gitTuning?: GitTuningMode; gitTuningFsmonitor?: boolean }
type GitTuningStore = {
  getSettings(): GitTuningSettings
  getRepos(): readonly PerformanceConfigRepo[]
  onSettingsChanged(listener: (updates: GitTuningSettings) => void): () => void
}
type RunOptions = GitPerformanceConfigOptions & { admissionTier?: GitAdmissionTier }

// Why per repo: a registration apply, a settings revert and the pane's read
// must not interleave their config writes and reads.
const perRepo = new KeyedSerialRunner()
// Mirror the persisted settings; owned by startup so no registration path reads the store.
let gitTuningMode: GitTuningMode = 'off'
let gitTuningFsmonitor = false

// Why: drvfs (/mnt/<drive>) does not keep directory mtimes the way the distro's ext4 does.
function wslLinuxPathHasReliableMtime(linuxPath: string): boolean {
  return !/^\/mnt\/[a-z](?:\/|$)/i.test(linuxPath)
}

export function createLocalGitPerformanceConfigHost(
  repoPath: string,
  capabilities: GitCapabilityCache,
  admissionTier: GitAdmissionTier
): GitPerformanceConfigHost {
  const wsl = process.platform === 'win32' ? parseWslUncPath(repoPath) : null
  return {
    // A WSL repo runs the distro's Linux Git, so Linux rules (no fsmonitor) apply.
    platform: wsl ? 'linux' : process.platform,
    git: (args) => gitExecFileAsync(args, { cwd: repoPath, admissionTier }),
    capabilities,
    hasReliableDirectoryMtime: () =>
      wsl
        ? Promise.resolve(wslLinuxPathHasReliableMtime(wsl.linuxPath))
        : detectReliableDirectoryMtime(repoPath, process.platform),
    resolveGitPath: (gitPath) => {
      if (wsl && gitPath.startsWith('/')) {
        return toWindowsWslPath(gitPath, wsl.distro)
      }
      return isAbsolute(gitPath) ? gitPath : join(repoPath, gitPath)
    }
  }
}

async function runOnExecutionHost(
  repo: PerformanceConfigRepo,
  action: GitPerformanceConfigAction,
  { admissionTier = 'interactive', ...options }: RunOptions
): Promise<RepoPerformanceConfigOutcome> {
  const sshTargetId = getRepoSshConnectionId(repo)
  if (sshTargetId) {
    const provider = getSshGitProvider(sshTargetId)
    if (!provider) {
      return { status: 'unavailable', reason: 'ssh-disconnected' }
    }
    const result = await provider.repoPerformanceConfig(repo.path, action, options)
    return result
      ? { status: 'ok', ...result }
      : { status: 'unavailable', reason: 'relay-outdated' }
  }
  const result = await withLocalGitCapabilityCacheForExecution({ cwd: repo.path }, (capabilities) =>
    runGitPerformanceConfigAction(
      createLocalGitPerformanceConfigHost(repo.path, capabilities, admissionTier),
      action,
      options
    )
  )
  return { status: 'ok', ...result }
}

export function runRepoPerformanceConfig(
  repo: PerformanceConfigRepo,
  action: GitPerformanceConfigAction,
  options: RunOptions = {}
): Promise<RepoPerformanceConfigOutcome> {
  if (isFolderRepo(repo)) {
    return Promise.resolve({ status: 'unavailable', reason: 'not-git' })
  }
  return perRepo.run(repo.id, async () => {
    try {
      return await runOnExecutionHost(repo, action, options)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })
}

function warnOnFailure(outcome: RepoPerformanceConfigOutcome): void {
  if (outcome.status === 'unavailable' && outcome.reason === 'failed') {
    console.warn('[git-tuning] repository config update failed:', outcome.message)
  }
}

/** After a project is added; never blocks or fails the registration that called it. */
export function applyRepoPerformanceConfigOnAdd(repo: PerformanceConfigRepo): void {
  if (gitTuningMode !== 'recommended' || isFolderRepo(repo)) {
    return
  }
  void runRepoPerformanceConfig(repo, 'apply', {
    admissionTier: 'background',
    fsmonitor: gitTuningFsmonitor
  }).then(warnOnFailure)
}

/** Turning a setting off removes only what Orca recorded, in every reachable repository. */
function revertRepoPerformanceConfigForAll(
  repos: readonly PerformanceConfigRepo[],
  options: GitPerformanceConfigOptions = {}
): void {
  for (const repo of repos) {
    if (!isFolderRepo(repo)) {
      void runRepoPerformanceConfig(repo, 'revert', {
        ...options,
        admissionTier: 'background'
      }).then(warnOnFailure)
    }
  }
}

/**
 * Startup wiring for every process that loads the store (desktop and headless serve).
 * Every settings writer (pane, CLI, paired client) then gets the same revert on Off.
 */
export function trackGitTuningSetting(store: GitTuningStore): () => void {
  const settings = store.getSettings()
  gitTuningMode = normalizeGitTuningMode(settings.gitTuning)
  gitTuningFsmonitor = settings.gitTuningFsmonitor === true
  return store.onSettingsChanged((updates) => {
    if ('gitTuningFsmonitor' in updates) {
      gitTuningFsmonitor = updates.gitTuningFsmonitor === true
    }
    if ('gitTuning' in updates) {
      gitTuningMode = normalizeGitTuningMode(updates.gitTuning)
      if (gitTuningMode === 'off') {
        revertRepoPerformanceConfigForAll(store.getRepos())
        return
      }
    }
    if ('gitTuningFsmonitor' in updates && !gitTuningFsmonitor) {
      revertRepoPerformanceConfigForAll(store.getRepos(), { keys: ['core.fsmonitor'] })
    }
  })
}
