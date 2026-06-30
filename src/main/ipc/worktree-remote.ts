/* eslint-disable max-lines */
// Why: extracted from worktrees.ts to keep the main IPC module under the
// max-lines threshold. Worktree creation helpers (local and remote) live
// here so the IPC dispatch file stays focused on handler wiring. The
// sparse-checkout flow plus the post-create setup-runner wiring pushed
// this file marginally over the per-file limit; matches the
// eslint-disable pattern other files in src/renderer use when a
// cohesive flow would split awkwardly.

import type { BrowserWindow } from 'electron'
import { posix, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import type {
  AutomationWorkspaceProvenance,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  GitPushTarget,
  GlobalSettings,
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion,
  Repo,
  Worktree,
  WorktreeMeta
} from '../../shared/types'
import { getPRForBranch } from '../github/client'
import { listWorktrees, addWorktree, addSparseWorktree } from '../git/worktree'
import type { AddWorktreeOptions, AddWorktreeResult } from '../git/worktree'
import { getGitUsername, getBranchConflictKind, resolveDefaultBaseRefViaExec } from '../git/repo'
import { hasCommitObjectViaGitExec } from '../git/commit-object-ref'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import type { ForgeProviderId } from '../source-control/forge-provider'
import { validateGitPushTarget } from '../git/push-target-validation'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { gitExecFileAsync } from '../git/runner'
import { parseGitHubOwnerRepo } from '../github/gh-utils'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RemoteFetchResult, RemoteTrackingBase } from '../runtime/orca-runtime'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-projection'
import {
  buildPosixRunnerScript,
  buildWindowsRunnerScript,
  createSetupRunnerScript,
  getDefaultTabsLaunch,
  getEffectiveHooks,
  getEffectiveHooksFromConfig,
  getSetupRunnerEnvVars,
  loadHooks,
  parseOrcaYaml,
  shouldRunSetupForCreate
} from '../hooks'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getActiveMultiplexer } from './ssh'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/tui-agent-config'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { getSshGitUsername } from '../git/git-username'
import { runWorktreeChangeInvalidators } from './worktree-change-invalidators'

type CreateWorktreeArgsWithSystemProvenance = CreateWorktreeArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
}
import {
  sanitizeWorktreeName,
  sanitizeWorktreeDisplayName,
  computeBranchName,
  computeWorktreePath,
  computeRemoteWorktreePath,
  computeWorkspaceRoot,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath,
  shouldSetDisplayName,
  mergeWorktree,
  areWorktreePathsEqual
} from './worktree-logic'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  sameGitHubRemoteUrl,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'
import {
  configureCreatedWorktreePushTargetWithExec,
  prepareWorktreePushTargetWithExec
} from './worktree-push-target-setup'
import { isENOENT, registerWorktreeRootsForRepo } from './filesystem-auth'
import { createWorktreeLinkedPaths } from './worktree-symlinks'
import { normalizeSparseDirectories } from './sparse-checkout-directories'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import type { IFilesystemProvider } from '../providers/types'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../shared/setup-runner-command'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import { shouldWaitForSetupBeforeAgentStartup } from '../../shared/setup-agent-startup-policy'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import {
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} from '../agent-trust-presets'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import {
  getBranchNameOverrideCandidate,
  getWorktreeCreateCandidate,
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS
} from '../worktree-create-candidates'

const SSH_WORKTREE_CREATE_FETCH_FRESHNESS_MS = 30_000
const SSH_WORKTREE_CREATE_FETCH_CACHE_MAX = 512
const sshWorktreeCreateFetchInflight = new Map<string, Promise<void>>()
const sshWorktreeCreateFetchCompletedAt = new Map<string, number>()
const sshWorktreeCreateFetchQueueTail = new Map<string, Promise<void>>()
const sshWorktreeCreateBasePlanInflight = new Map<
  string,
  Promise<RemoteWorktreeCreateBasePlan | null>
>()

type RemoteWorktreeCreateBasePlan = {
  baseBranch: string
  remoteTrackingBase: RemoteTrackingBase | null
}

type StagedStartupResult = {
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  activationSetup?: CreateWorktreeResult['setup']
  didSpawnSetup: boolean
  warning?: string
}

type RemoteLocalBaseRefRefreshability =
  | {
      refreshable: true
      baseRef: string
      localBranch: string
      fullRef: string
      remoteTrackingRef: string
      behind: number
      ownerWorktreePath?: string
    }
  | {
      refreshable: false
      result: LocalBaseRefRefreshResult
    }

function appendWorktreeCreateWarning(current: string | undefined, next: string): string {
  return current ? `${current} Also ${next[0]?.toLowerCase() ?? ''}${next.slice(1)}` : next
}

function validateWorkspaceLineageParentBeforeCreate(
  store: Store,
  parentWorkspace: CreateWorktreeArgs['parentWorkspace'],
  childWorkspaceKey: ReturnType<typeof worktreeWorkspaceKey>
): void {
  if (!parentWorkspace) {
    return
  }
  if (parentWorkspace === childWorkspaceKey) {
    throw new Error('A worktree cannot be attached to itself.')
  }
  const parentScope = parseWorkspaceKey(parentWorkspace)
  if (!parentScope) {
    throw new Error(`Invalid parent workspace: ${parentWorkspace}`)
  }
  if (parentScope.type === 'folder' && !store.getFolderWorkspace(parentScope.folderWorkspaceId)) {
    throw new Error(`Parent folder workspace not found: ${parentWorkspace}`)
  }
  if (parentScope.type === 'worktree' && !store.getWorktreeMeta(parentScope.worktreeId)) {
    throw new Error(`Parent worktree workspace not found: ${parentWorkspace}`)
  }
}

function recordWorkspaceLineageForCreatedWorktree(
  store: Store,
  args: CreateWorktreeArgs,
  worktree: Worktree,
  createdAt: number
): CreateWorktreeResult['workspaceLineage'] {
  if (!args.parentWorkspace || !worktree.instanceId) {
    return null
  }
  const childWorkspaceKey = worktreeWorkspaceKey(worktree.id)
  if (args.parentWorkspace === childWorkspaceKey) {
    console.warn(`[worktree-create] refusing to attach ${worktree.id} to itself`)
    return null
  }
  const parentScope = parseWorkspaceKey(args.parentWorkspace)
  if (!parentScope) {
    console.warn(`[worktree-create] ignoring invalid parent workspace ${args.parentWorkspace}`)
    return null
  }
  if (parentScope.type === 'folder' && !store.getFolderWorkspace(parentScope.folderWorkspaceId)) {
    console.warn(`[worktree-create] parent folder workspace disappeared: ${args.parentWorkspace}`)
    return null
  }
  const parentWorktreeMeta =
    parentScope.type === 'worktree' ? store.getWorktreeMeta(parentScope.worktreeId) : null
  if (parentScope.type === 'worktree' && !parentWorktreeMeta) {
    console.warn(`[worktree-create] parent worktree workspace disappeared: ${args.parentWorkspace}`)
    return null
  }
  return store.setWorkspaceLineage({
    childWorkspaceKey,
    childInstanceId: worktree.instanceId,
    parentWorkspaceKey: args.parentWorkspace,
    parentInstanceId: parentWorktreeMeta?.instanceId ?? null,
    origin: 'manual',
    capture: { source: 'active-workspace', confidence: 'explicit' },
    createdAt
  })
}

function countNonEmptyGitOutputLines(output: string): number {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).length
}

async function spawnLocalStartupAndSetupTerminals(args: {
  runtime: OrcaRuntimeService | undefined
  worktree: Pick<Worktree, 'id' | 'path'>
  startup: CreateWorktreeArgs['startup']
  setup: CreateWorktreeResult['setup']
  defaultTabs: CreateWorktreeResult['defaultTabs']
  settings: GlobalSettings
  createdWithAgent: CreateWorktreeArgs['createdWithAgent']
}): Promise<StagedStartupResult> {
  const { runtime, worktree, startup, setup, defaultTabs, settings, createdWithAgent } = args
  if (!runtime || !startup || defaultTabs?.tabs.length) {
    return { didSpawnSetup: false }
  }

  let warning: string | undefined
  let startupTerminalHandle: string | null = null
  let startupTerminal: CreateWorktreeResult['startupTerminal']

  let sequencedStartup = startup
  let wrappedSetupCommandStr: string | undefined
  if (startup && setup?.waitForAgentStartup === true) {
    const platform = getSetupRunnerCommandPlatformForPath(
      setup.runnerScriptPath,
      process.platform === 'win32' ? 'windows' : 'posix'
    )
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup.command,
      platform
    })
    sequencedStartup = {
      ...startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommandStr = sequenced.setupCommand
  }

  try {
    // Why: after `git worktree add` and metadata registration, a runtime-owned
    // PTY can begin booting the selected agent while setup runs in a sibling
    // terminal. Earlier than this, the worktree path is not yet safe for agents.
    if (isTuiAgent(createdWithAgent)) {
      const preset = TUI_AGENT_CONFIG[createdWithAgent].preflightTrust
      try {
        if (preset === 'cursor') {
          markCursorWorkspaceTrusted(worktree.path)
        } else if (preset === 'copilot') {
          markCopilotFolderTrusted(worktree.path)
        } else if (preset === 'codex') {
          markCodexProjectTrusted(worktree.path)
        }
      } catch {
        // Best-effort: launch still proceeds and the agent can ask interactively.
      }
    }
    const terminal = await runtime.createTerminal(`id:${worktree.id}`, {
      command: sequencedStartup.command,
      ...(setup ? { claudeAgentTeamsSourceCommand: startup.command } : {}),
      env: sequencedStartup.env,
      ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
      ...(isTuiAgent(createdWithAgent) ? { launchAgent: createdWithAgent } : {}),
      startupCommandDelivery: sequencedStartup.startupCommandDelivery,
      telemetry: sequencedStartup.telemetry,
      activate: true
    })
    startupTerminalHandle = terminal.handle
    startupTerminal = {
      spawned: true,
      surface: terminal.surface
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warning = `Failed to create the startup terminal for ${worktree.path}: ${message}`
    console.warn(`[worktree-create] ${warning}`)
    return { didSpawnSetup: false, warning }
  }

  let didSpawnSetup = false
  if (setup) {
    try {
      const setupCommand =
        wrappedSetupCommandStr ??
        buildSetupRunnerCommand(
          setup.runnerScriptPath,
          getSetupRunnerCommandPlatformForPath(
            setup.runnerScriptPath,
            process.platform === 'win32' ? 'windows' : 'posix'
          )
        )
      const setupLaunchMode =
        (settings as Partial<Pick<GlobalSettings, 'setupScriptLaunchMode'>>)
          .setupScriptLaunchMode ?? 'new-tab'
      if (setupLaunchMode === 'split-vertical' || setupLaunchMode === 'split-horizontal') {
        if (!startupTerminalHandle) {
          throw new Error('startup_terminal_missing')
        }
        await runtime.splitTerminal(startupTerminalHandle, {
          direction: setupLaunchMode === 'split-horizontal' ? 'horizontal' : 'vertical',
          command: setupCommand,
          env: setup.envVars,
          activate: false
        })
      } else {
        await runtime.createTerminal(`id:${worktree.id}`, {
          title: 'Setup',
          command: setupCommand,
          env: setup.envVars,
          activate: false
        })
      }
      didSpawnSetup = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const nextWarning = `failed to create the setup terminal for ${worktree.path}: ${message}`
      warning = appendWorktreeCreateWarning(warning, nextWarning)
      console.warn(`[worktree-create] ${warning}`)
    }
  }

  return {
    ...(setup && !didSpawnSetup
      ? {
          activationSetup: {
            ...setup,
            ...(startupTerminalHandle && wrappedSetupCommandStr
              ? { command: wrappedSetupCommandStr }
              : {})
          }
        }
      : {}),
    ...(startupTerminal ? { startupTerminal } : {}),
    didSpawnSetup,
    ...(warning ? { warning } : {})
  }
}

function setBoundedSshWorktreeCreateFetchEntry(
  map: Map<string, number>,
  key: string,
  value: number
): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > SSH_WORKTREE_CREATE_FETCH_CACHE_MAX) {
    const oldest = map.keys().next()
    if (oldest.done) {
      return
    }
    map.delete(oldest.value)
  }
}

function getSshWorktreeCreateBaseFetchKey(repo: Repo, base: RemoteTrackingBase): string {
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::base:${base.remote}:${base.branch}`
}

function getSshWorktreeCreateRemoteFetchKey(repo: Repo, remote: string): string {
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::remote:${remote}`
}

function getSshWorktreeCreateRemoteQueueKey(repo: Repo, remote: string): string {
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::queue:${remote}`
}

function getSshWorktreeCreateBasePlanKey(
  repo: Repo,
  requestedBaseBranch: string | undefined
): string {
  const baseKey = requestedBaseBranch || repo.worktreeBaseRef || 'default'
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::plan:${baseKey}`
}

function getFreshSshWorktreeCreateFetchCompletedAt(key: string): number | null {
  const lastAt = sshWorktreeCreateFetchCompletedAt.get(key)
  if (lastAt === undefined) {
    return null
  }
  if (Date.now() - lastAt < SSH_WORKTREE_CREATE_FETCH_FRESHNESS_MS) {
    setBoundedSshWorktreeCreateFetchEntry(sshWorktreeCreateFetchCompletedAt, key, lastAt)
    return lastAt
  }
  sshWorktreeCreateFetchCompletedAt.delete(key)
  return null
}

function rememberSshWorktreeCreateFetchCompletedAt(key: string): void {
  setBoundedSshWorktreeCreateFetchEntry(sshWorktreeCreateFetchCompletedAt, key, Date.now())
}

function enqueueSshWorktreeCreateFetch(
  queueKey: string,
  fetch: () => Promise<void>
): Promise<void> {
  const previous = sshWorktreeCreateFetchQueueTail.get(queueKey)
  const promise = previous ? previous.then(fetch, fetch) : fetch()
  sshWorktreeCreateFetchQueueTail.set(queueKey, promise)
  const clearQueueTail = (): void => {
    if (sshWorktreeCreateFetchQueueTail.get(queueKey) === promise) {
      sshWorktreeCreateFetchQueueTail.delete(queueKey)
    }
  }
  promise.then(clearQueueTail, clearQueueTail)
  return promise
}

async function getOrStartSshWorktreeCreateFetch(
  key: string,
  queueKey: string,
  fetch: () => Promise<void>
): Promise<void> {
  if (getFreshSshWorktreeCreateFetchCompletedAt(key) !== null) {
    return
  }
  const existing = sshWorktreeCreateFetchInflight.get(key)
  if (existing) {
    return existing
  }
  const promise = enqueueSshWorktreeCreateFetch(queueKey, async () => {
    if (getFreshSshWorktreeCreateFetchCompletedAt(key) !== null) {
      return
    }
    await fetch()
    // Why: SSH creation has no OrcaRuntimeService instance to share, but
    // repeated creates on the same target should still reuse recent fetches.
    rememberSshWorktreeCreateFetchCompletedAt(key)
  }).finally(() => {
    if (sshWorktreeCreateFetchInflight.get(key) === promise) {
      sshWorktreeCreateFetchInflight.delete(key)
    }
  })
  sshWorktreeCreateFetchInflight.set(key, promise)
  return promise
}

async function refreshRemoteTrackingBaseForWorktreeCreate(
  provider: SshGitProvider,
  repo: Repo,
  base: RemoteTrackingBase
): Promise<void> {
  return getOrStartSshWorktreeCreateFetch(
    getSshWorktreeCreateBaseFetchKey(repo, base),
    getSshWorktreeCreateRemoteQueueKey(repo, base.remote),
    () => provider.fetchRemoteTrackingRef(repo.path, base.remote, base.branch, base.ref)
  )
}

async function fetchRemoteForWorktreeCreate(
  provider: SshGitProvider,
  repo: Repo,
  remote: string
): Promise<void> {
  return getOrStartSshWorktreeCreateFetch(
    getSshWorktreeCreateRemoteFetchKey(repo, remote),
    getSshWorktreeCreateRemoteQueueKey(repo, remote),
    () => provider.exec(['fetch', remote], repo.path).then(() => undefined)
  )
}

export function __resetSshWorktreeCreateFetchCacheForTests(): void {
  sshWorktreeCreateFetchInflight.clear()
  sshWorktreeCreateFetchCompletedAt.clear()
  sshWorktreeCreateFetchQueueTail.clear()
  sshWorktreeCreateBasePlanInflight.clear()
}

async function unsetRemoteWorktreeCreationBase(
  provider: SshGitProvider,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    await provider.exec(
      ['config', '--local', '--unset-all', `branch.${branchName}.base`],
      worktreePath
    )
  } catch {
    // Best-effort SSH sparse cleanup; keep the sparse setup error as the
    // actionable failure and let removeWorktree handle the partial checkout.
  }
}

async function resolveCreateBranchName(
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  username: string | null,
  gitOptions: { wslDistro?: string } = {}
): Promise<string> {
  if (!branchNameOverride) {
    return computeBranchName(sanitizedName, settings, username)
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await gitExecFileAsync(['check-ref-format', '--branch', branchNameOverride], {
    cwd: repoPath,
    ...gitOptions
  })
  return branchNameOverride
}

async function resolveCreateBranchNameSsh(
  provider: SshGitProvider,
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  username: string | null
): Promise<string> {
  if (!branchNameOverride) {
    return computeBranchName(sanitizedName, settings, username)
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await provider.exec(['check-ref-format', '--branch', branchNameOverride], repoPath)
  return branchNameOverride
}

function normalizeLocalBranchName(branchName: string | undefined): string {
  return branchName?.replace(/^refs\/heads\//, '') ?? ''
}

async function canCheckoutExistingLocalBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  gitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  let localHead = ''
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      {
        cwd: repoPath,
        ...gitOptions
      }
    )
    localHead = stdout.trim()
  } catch {
    return false
  }
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    if (!localHead) {
      return false
    }
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        { cwd: repoPath, ...gitOptions }
      )
      if (stdout.trim() !== localHead) {
        return false
      }
    } catch {
      return false
    }
  }
  const worktrees = await listWorktrees(repoPath, gitOptions)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

function hasLocalGitOptions(gitOptions: { wslDistro?: string }): boolean {
  return Object.keys(gitOptions).length > 0
}

function hasLocalCommitObjectWithOptions(
  repoPath: string,
  ref: string,
  gitOptions: { wslDistro?: string }
): Promise<boolean> {
  return hasCommitObjectViaGitExec(
    (gitArgs) => gitExecFileAsync(gitArgs, { cwd: repoPath, ...gitOptions }),
    ref
  )
}

function getLocalGitHubPrForBranch(
  repoPath: string,
  branchName: string,
  gitOptions: { wslDistro?: string }
): ReturnType<typeof getPRForBranch> {
  return hasLocalGitOptions(gitOptions)
    ? getPRForBranch(repoPath, branchName, null, null, null, { localGitExecOptions: gitOptions })
    : getPRForBranch(repoPath, branchName)
}

function hasRemoteCommitObject(
  provider: SshGitProvider,
  repoPath: string,
  ref: string
): Promise<boolean> {
  return hasCommitObjectViaGitExec((gitArgs) => provider.exec(gitArgs, repoPath), ref)
}

async function canCheckoutExistingLocalBranchSsh(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string,
  baseBranch: string
): Promise<boolean> {
  let localHead = ''
  try {
    const { stdout } = await provider.exec(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      repoPath
    )
    localHead = stdout.trim()
  } catch {
    return false
  }
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    if (!localHead) {
      return false
    }
    try {
      const { stdout } = await provider.exec(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        repoPath
      )
      if (stdout.trim() !== localHead) {
        return false
      }
    } catch {
      return false
    }
  }
  const worktrees = await provider.listWorktrees(repoPath)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

async function listSshRemoteNames(provider: SshGitProvider, repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await provider.exec(['remote'], repoPath)
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  } catch {
    return []
  }
}

function isAllowedSshRemoteBaseRef(refName: string, allowedBaseRef: string): boolean {
  if (!allowedBaseRef) {
    return false
  }
  const normalizedAllowedRef = allowedBaseRef.startsWith('refs/remotes/')
    ? allowedBaseRef
    : `refs/remotes/${allowedBaseRef}`
  return refName === normalizedAllowedRef
}

function resolveSshRemoteBranchName(refName: string, remoteNames: string[]): string {
  const remotePrefix = 'refs/remotes/'
  if (!refName.startsWith(remotePrefix)) {
    return refName
  }
  const remoteAndBranch = refName.slice(remotePrefix.length)
  const remote = remoteNames.find((candidate) => remoteAndBranch.startsWith(`${candidate}/`))
  if (remote) {
    return remoteAndBranch.slice(remote.length + 1)
  }
  return remoteAndBranch.split('/').slice(1).join('/') || remoteAndBranch
}

async function hasSshRemoteBranchConflict(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string,
  allowedBaseRef: string
): Promise<boolean> {
  const remoteNames = await listSshRemoteNames(provider, repoPath)
  try {
    const { stdout } = await provider.exec(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      repoPath
    )
    return stdout.split(/\r?\n/).some((line) => {
      const refName = line.trim()
      if (!refName || /^refs\/remotes\/.+\/HEAD$/.test(refName)) {
        return false
      }
      if (isAllowedSshRemoteBaseRef(refName, allowedBaseRef)) {
        return false
      }
      // Why: `git branch --all --list feature/x` does not match
      // `remotes/origin/feature/x`; parse remote refs directly instead.
      return resolveSshRemoteBranchName(refName, remoteNames) === branchName
    })
  } catch {
    return false
  }
}

async function hasSshLocalBranchConflict(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    const { stdout } = await provider.exec(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      repoPath
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function getSshBranchConflictKind(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string,
  allowedBaseRef: string
): Promise<'local' | 'remote' | null> {
  if (await hasSshLocalBranchConflict(provider, repoPath, branchName)) {
    return 'local'
  }
  return (await hasSshRemoteBranchConflict(provider, repoPath, branchName, allowedBaseRef))
    ? 'remote'
    : null
}

type SelectedReviewBranchInput = Pick<
  CreateWorktreeArgs,
  | 'branchNameOverride'
  | 'linkedPR'
  | 'linkedGitLabMR'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'
  | 'pushTarget'
>

type SelectedReviewBranch = {
  provider: ForgeProviderId
  number: number
}

function getSelectedReviewBranch(args: SelectedReviewBranchInput): SelectedReviewBranch | null {
  if (typeof args.linkedPR === 'number') {
    return { provider: 'github', number: args.linkedPR }
  }
  if (typeof args.linkedGitLabMR === 'number') {
    return { provider: 'gitlab', number: args.linkedGitLabMR }
  }
  if (typeof args.linkedBitbucketPR === 'number') {
    return { provider: 'bitbucket', number: args.linkedBitbucketPR }
  }
  if (typeof args.linkedAzureDevOpsPR === 'number') {
    return { provider: 'azure-devops', number: args.linkedAzureDevOpsPR }
  }
  if (typeof args.linkedGiteaPR === 'number') {
    return { provider: 'gitea', number: args.linkedGiteaPR }
  }
  return null
}

function isSelectedGitHubPrBranchOverride(
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return typeof args.linkedPR === 'number' && args.branchNameOverride === branchName
}

function isSelectedReviewBranchOverride(
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return getSelectedReviewBranch(args) !== null && args.branchNameOverride === branchName
}

function isMatchingSelectedGitHubPr(
  existingPR: Awaited<ReturnType<typeof getPRForBranch>>,
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return Boolean(
    existingPR &&
    isSelectedGitHubPrBranchOverride(args, branchName) &&
    existingPR.number === args.linkedPR
  )
}

function isAllowedPushTargetRemoteConflict(
  conflictKind: 'local' | 'remote' | null,
  branchName: string,
  args: SelectedReviewBranchInput
): boolean {
  return (
    conflictKind === 'remote' &&
    isSelectedReviewBranchOverride(args, branchName) &&
    args.pushTarget?.branchName === branchName
  )
}

function getSelectedReviewLookupHints(args: SelectedReviewBranchInput): {
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
} {
  return {
    linkedGitHubPR: args.linkedPR ?? null,
    linkedGitLabMR: args.linkedGitLabMR ?? null,
    linkedBitbucketPR: args.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: args.linkedGiteaPR ?? null
  }
}

async function getSelectedHostedReviewForBranch(
  repo: Pick<Repo, 'path' | 'connectionId'>,
  branchName: string,
  args: SelectedReviewBranchInput
): Promise<{ matchesSelected: boolean; number: number } | null> {
  const selectedReview = getSelectedReviewBranch(args)
  if (!selectedReview) {
    return null
  }
  const review = await getHostedReviewForBranch({
    repoPath: repo.path,
    connectionId: repo.connectionId ?? null,
    branch: branchName,
    ...getSelectedReviewLookupHints(args)
  })
  if (!review) {
    return null
  }
  return {
    matchesSelected:
      review.provider === selectedReview.provider && review.number === selectedReview.number,
    number: review.number
  }
}

async function remotePathExists(
  fsProvider: IFilesystemProvider | null | undefined,
  pathValue: string
): Promise<boolean> {
  if (!fsProvider?.stat) {
    return false
  }
  try {
    await fsProvider.stat(pathValue)
    return true
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}

export async function prepareWorktreePushTarget(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string,
  gitOptions: { wslDistro?: string } = {}
): Promise<GitPushTarget> {
  await validateGitPushTarget(repoPath, target, gitOptions)
  return prepareWorktreePushTargetWithExec(
    (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
    repoPath,
    target,
    (existingRemote) =>
      store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            { ...target, remoteName: existingRemote },
            repoId
          )
        : false
  )
}

function isPushTargetRemoteCreatedByKnownWorktree(
  store: WorktreePushTargetStore,
  target: GitPushTarget,
  repoId?: string
): boolean {
  return Object.entries(store.getAllWorktreeMeta()).some(([worktreeId, meta]) => {
    if (repoId && getRepoIdFromWorktreeId(worktreeId) !== repoId) {
      return false
    }
    if (!meta.pushTarget?.remoteCreated) {
      return false
    }
    const otherRemoteUrl = meta.pushTarget.remoteUrl
    const targetRemoteUrl = target.remoteUrl
    return (
      meta.pushTarget.remoteName === target.remoteName ||
      (typeof otherRemoteUrl === 'string' &&
        typeof targetRemoteUrl === 'string' &&
        sameGitHubRemoteUrl(otherRemoteUrl, targetRemoteUrl))
    )
  })
}

export async function cleanupUnusedWorktreePushTargetRemote(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  gitOptions: { wslDistro?: string } = {}
): Promise<void> {
  try {
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      repoPath,
      removedWorktreeId,
      target,
      store,
      (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions })
    )
  } catch (error) {
    console.warn(`[worktrees] Failed to clean up fork PR remote for ${removedWorktreeId}`, error)
  }
}

export async function configureCreatedWorktreePushTarget(
  worktreePath: string,
  branchName: string,
  target: GitPushTarget,
  gitOptions: { wslDistro?: string } = {}
): Promise<GitPushTarget> {
  return configureCreatedWorktreePushTargetWithExec(
    (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
    worktreePath,
    branchName,
    target
  )
}

async function findRemoteForUrlSsh(
  provider: SshGitProvider,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  const target = parseGitHubOwnerRepo(remoteUrl)
  try {
    const { stdout } = await provider.exec(['remote'], repoPath)
    for (const remote of stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      try {
        const { stdout: urlStdout } = await provider.exec(['remote', 'get-url', remote], repoPath)
        const candidateUrl = urlStdout.trim()
        const candidate = parseGitHubOwnerRepo(candidateUrl)
        if (
          target &&
          candidate &&
          target.owner.toLowerCase() === candidate.owner.toLowerCase() &&
          target.repo.toLowerCase() === candidate.repo.toLowerCase()
        ) {
          return remote
        }
        if (candidateUrl === remoteUrl) {
          return remote
        }
      } catch {
        // Ignore a remote that disappeared or has no fetch URL.
      }
    }
  } catch {
    return null
  }
  return null
}

async function ensureUniqueRemoteNameSsh(
  provider: SshGitProvider,
  repoPath: string,
  preferred: string
): Promise<string> {
  const { stdout } = await provider.exec(['remote'], repoPath)
  const existing = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  if (!existing.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

async function prepareWorktreePushTargetSsh(
  provider: SshGitProvider,
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string
): Promise<GitPushTarget> {
  assertGitPushTargetShape(target)
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  await provider.exec(['check-ref-format', '--branch', target.branchName], repoPath)
  let remoteName = target.remoteName
  let remoteCreated = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrlSsh(provider, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: if a later PR worktree reuses an Orca-created fork remote, it
      // must inherit ownership so deleting the final user can remove it.
      remoteCreated = store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            {
              ...target,
              remoteName: existingRemote
            },
            repoId
          )
        : false
    } else {
      remoteName = await ensureUniqueRemoteNameSsh(provider, repoPath, target.remoteName)
      await provider.exec(['remote', 'add', remoteName, target.remoteUrl], repoPath)
      remoteCreated = true
    }
  }
  await provider.fetchRemoteTrackingRef(
    repoPath,
    remoteName,
    target.branchName,
    `refs/remotes/${remoteName}/${target.branchName}`
  )
  return { ...sanitizedTarget, remoteName, ...(remoteCreated ? { remoteCreated: true } : {}) }
}

export async function cleanupUnusedWorktreePushTargetRemoteSsh(
  provider: SshGitProvider,
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore
): Promise<void> {
  try {
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      repoPath,
      removedWorktreeId,
      target,
      store,
      (args, cwd) => provider.exec(args, cwd)
    )
  } catch (error) {
    console.warn(
      `[worktrees] Failed to clean up remote fork PR remote for ${removedWorktreeId}`,
      error
    )
  }
}

async function configureCreatedWorktreePushTargetSsh(
  provider: SshGitProvider,
  worktreePath: string,
  branchName: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  await provider.exec(
    ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
    worktreePath
  )
  return target
}

async function readRemoteEffectiveHooks(
  repo: Repo,
  fsProvider: IFilesystemProvider,
  hooksRootPath: string
): Promise<ReturnType<typeof getEffectiveHooksFromConfig>> {
  return getEffectiveHooksFromConfig(repo, await readRemoteOrcaYaml(fsProvider, hooksRootPath))
}

async function readRemoteOrcaYaml(
  fsProvider: IFilesystemProvider,
  hooksRootPath: string
): Promise<ReturnType<typeof parseOrcaYaml>> {
  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(hooksRootPath, 'orca.yaml'))
    return result.isBinary ? null : parseOrcaYaml(result.content)
  } catch {
    return null
  }
}

async function createRemoteSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  gitProvider: SshGitProvider,
  fsProvider: IFilesystemProvider
): Promise<CreateWorktreeResult['setup']> {
  const useWindowsFormat = isWindowsAbsolutePathLike(worktreePath)
  const runnerRelativePath = useWindowsFormat ? 'orca/setup-runner.cmd' : 'orca/setup-runner.sh'
  const { stdout } = await gitProvider.exec(
    ['rev-parse', '--git-path', runnerRelativePath],
    worktreePath
  )
  const runnerScriptPath = stdout.trim()
  const runnerDir = useWindowsFormat
    ? win32.dirname(runnerScriptPath)
    : posix.dirname(runnerScriptPath)
  await fsProvider.createDir(runnerDir)
  await fsProvider.writeFile(
    runnerScriptPath,
    useWindowsFormat ? buildWindowsRunnerScript(script) : buildPosixRunnerScript(script)
  )
  return {
    runnerScriptPath,
    envVars: getSetupRunnerEnvVars(repo, worktreePath),
    ...(shouldWaitForSetupBeforeAgentStartup(repo.hookSettings?.setupAgentStartupPolicy)
      ? { waitForAgentStartup: true }
      : {})
  }
}

async function resolveRemoteTrackingBaseSsh(
  provider: SshGitProvider,
  repoPath: string,
  baseBranch: string
): Promise<RemoteTrackingBase | null> {
  let remotes: string[]
  try {
    const { stdout } = await provider.exec(['remote'], repoPath)
    remotes = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return null
  }

  const remoteRefPrefix = 'refs/remotes/'
  const shortBaseBranch = baseBranch.startsWith(remoteRefPrefix)
    ? baseBranch.slice(remoteRefPrefix.length)
    : baseBranch
  const remote = remotes
    .filter((candidate) => shortBaseBranch.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)[0]
  if (!remote) {
    return null
  }
  const branch = shortBaseBranch.slice(remote.length + 1)
  if (!branch) {
    return null
  }
  return {
    remote,
    branch,
    ref: `refs/remotes/${remote}/${branch}`,
    base: `${remote}/${branch}`
  }
}

async function resolveRemoteWorktreeCreateBase(
  provider: SshGitProvider,
  repo: Repo,
  requestedBaseBranch: string | undefined
): Promise<string | null> {
  let baseBranch = requestedBaseBranch || repo.worktreeBaseRef
  if (baseBranch) {
    return baseBranch
  }
  try {
    const { stdout } = await provider.exec(
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      repo.path
    )
    baseBranch = stdout.trim()
  } catch {
    return null
  }
  return baseBranch || null
}

async function resolveRemoteWorktreeCreateBasePlan(
  provider: SshGitProvider,
  repo: Repo,
  requestedBaseBranch: string | undefined
): Promise<RemoteWorktreeCreateBasePlan | null> {
  const baseBranch = await resolveRemoteWorktreeCreateBase(provider, repo, requestedBaseBranch)
  if (!baseBranch) {
    return null
  }
  return {
    baseBranch,
    remoteTrackingBase: await resolveRemoteTrackingBaseSsh(provider, repo.path, baseBranch)
  }
}

function getOrStartRemoteWorktreeCreateBasePlan(
  provider: SshGitProvider,
  repo: Repo,
  requestedBaseBranch: string | undefined
): Promise<RemoteWorktreeCreateBasePlan | null> {
  const key = getSshWorktreeCreateBasePlanKey(repo, requestedBaseBranch)
  const existing = sshWorktreeCreateBasePlanInflight.get(key)
  if (existing) {
    return existing
  }
  const promise = resolveRemoteWorktreeCreateBasePlan(provider, repo, requestedBaseBranch).finally(
    () => {
      if (sshWorktreeCreateBasePlanInflight.get(key) === promise) {
        sshWorktreeCreateBasePlanInflight.delete(key)
      }
    }
  )
  sshWorktreeCreateBasePlanInflight.set(key, promise)
  return promise
}

export async function prefetchRemoteWorktreeCreateBase(
  provider: SshGitProvider,
  repo: Repo,
  args: { baseBranch?: string }
): Promise<void> {
  const basePlan = await getOrStartRemoteWorktreeCreateBasePlan(provider, repo, args.baseBranch)
  if (!basePlan) {
    return
  }
  if (basePlan.remoteTrackingBase) {
    await refreshRemoteTrackingBaseForWorktreeCreate(provider, repo, basePlan.remoteTrackingBase)
    return
  }
  if (await hasRemoteCommitObject(provider, repo.path, basePlan.baseBranch)) {
    // Why: PR/MR resolvers already fetched verified SHA start points. A broad
    // remote fetch only updates unrelated refs when the commit object exists.
    return
  }

  // Why: mirrors createRemoteWorktree's legacy local-base fallback so
  // prefetch and create share one process-local SSH fetch cache.
  const fallbackRemote = basePlan.baseBranch.includes('/')
    ? basePlan.baseBranch.split('/')[0]
    : 'origin'
  await fetchRemoteForWorktreeCreate(provider, repo, fallbackRemote)
}

async function refreshLocalBaseRefForRemoteWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase
): Promise<LocalBaseRefRefreshResult> {
  const evaluation = await evaluateRemoteLocalBaseRefRefreshability(
    provider,
    repoPath,
    remoteTrackingBase
  )
  if (!evaluation.refreshable) {
    return evaluation.result
  }

  const resultBase = { baseRef: evaluation.baseRef, localBranch: evaluation.localBranch }
  try {
    await provider.refreshLocalBaseRefForWorktreeCreate({
      repoPath,
      fullRef: evaluation.fullRef,
      remoteTrackingRef: evaluation.remoteTrackingRef,
      ...(evaluation.ownerWorktreePath ? { ownerWorktreePath: evaluation.ownerWorktreePath } : {})
    })
    return {
      ...resultBase,
      status: 'updated',
      ...(evaluation.ownerWorktreePath ? { ownerWorktreePath: evaluation.ownerWorktreePath } : {})
    }
  } catch {
    return { ...resultBase, status: 'skipped_error' }
  }
}

async function evaluateRemoteLocalBaseRefRefreshability(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase
): Promise<RemoteLocalBaseRefRefreshability> {
  const resultBase = {
    baseRef: remoteTrackingBase.base,
    localBranch: remoteTrackingBase.branch
  }
  const fullRef = `refs/heads/${remoteTrackingBase.branch}`

  let behind = 0
  try {
    // Why: SSH generic git.exec is allowlisted. `merge-base` and `log` are
    // allowed read-only probes; `rev-list` is intentionally not exposed there.
    await provider.exec(['merge-base', '--is-ancestor', fullRef, remoteTrackingBase.ref], repoPath)
    const { stdout } = await provider.exec(
      ['log', '--format=%H', `${fullRef}..${remoteTrackingBase.ref}`],
      repoPath
    )
    behind = countNonEmptyGitOutputLines(stdout)
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    const worktrees = await provider.listWorktrees(repoPath)
    const ownerWorktree = worktrees.find((wt) => wt.branch === fullRef)

    if (ownerWorktree) {
      const status = await provider.worktreeIsClean(ownerWorktree.path, {
        includeUntracked: false
      })
      if (!status.clean) {
        return {
          refreshable: false,
          result: {
            ...resultBase,
            status: 'skipped_dirty_worktree',
            ownerWorktreePath: ownerWorktree.path
          }
        }
      }
      return {
        refreshable: true,
        ...resultBase,
        fullRef,
        remoteTrackingRef: remoteTrackingBase.ref,
        behind,
        ownerWorktreePath: ownerWorktree.path
      }
    }

    // Why: not checked out anywhere — a bare ref fast-forward is safe. Omitting
    // ownerWorktreePath tells the relay to update-ref instead of reset --hard.
    return {
      refreshable: true,
      ...resultBase,
      fullRef,
      remoteTrackingRef: remoteTrackingBase.ref,
      behind
    }
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_error' } }
  }
}

async function getRemoteLocalBaseRefUpdateSuggestionForWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateRemoteLocalBaseRefRefreshability(
    provider,
    repoPath,
    remoteTrackingBase
  )
  if (!evaluation.refreshable || evaluation.behind <= 0) {
    return undefined
  }
  try {
    await provider.refreshLocalBaseRefForWorktreeCreate({
      repoPath,
      fullRef: evaluation.fullRef,
      remoteTrackingRef: evaluation.remoteTrackingRef,
      ...(evaluation.ownerWorktreePath ? { ownerWorktreePath: evaluation.ownerWorktreePath } : {}),
      checkOnly: true
    })
  } catch {
    return undefined
  }
  return {
    baseRef: evaluation.baseRef,
    localBranch: evaluation.localBranch,
    behind: evaluation.behind
  }
}

export function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  // Why: invalidate detected-worktree caches before renderer observers react,
  // so follow-up listDetected reads post-change state.
  runWorktreeChangeInvalidators(repoId)
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

// Why: two-phase spinner. Main process fires `'fetching'` before waiting on
// pre-create fetch work and `'creating'` immediately before `git worktree add`.
// Renderer swaps its spinner label in response; fallback is the static
// "Creating worktree..." label if no event arrives.
export function emitCreateWorktreeProgress(
  mainWindow: BrowserWindow,
  phase: 'fetching' | 'creating',
  creationId?: string
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('createWorktree:progress', { creationId, phase })
  }
}

export async function createRemoteWorktree(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow
): Promise<CreateWorktreeResult> {
  const timing = createWorktreeCreateTimingRecorder()
  const provider = requireSshGitProvider(repo.connectionId!)
  const fsProvider = getSshFilesystemProvider(repo.connectionId!)

  const settings = store.getSettings()
  const worktreePathSettings = getWorktreePathSettings(repo, settings)
  let effectiveRequestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  let effectiveSanitizedName = sanitizedName
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined

  // Why: SSH targets cannot use the local `gh` account, and git email/name are
  // commit author identity rather than hosted-account usernames.
  const username = await getSshGitUsername(provider, repo.path)

  // Determine base branch
  // Why: previously fell back to a hardcoded 'origin/main' when
  // symbolic-ref failed. That silently handed addWorktree a ref that may
  // not exist on the remote (e.g. repos whose primary branch is master or
  // develop), producing an opaque git error. Fail here with a clear
  // message so the UI can surface it and prompt the user to pick a base.
  const basePlan = await getOrStartRemoteWorktreeCreateBasePlan(provider, repo, args.baseBranch)
  if (!basePlan) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }
  const { baseBranch, remoteTrackingBase } = basePlan

  let branchName = ''
  let checkoutExistingBranch = false
  let remotePath = ''
  let selectedExistingLocalBranchName: string | null = null
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let remotePathResolved = false
  // Why: duplicate PR/MR checkouts still need a workspace; suffix the local
  // branch/path while preserving the review metadata and push target.
  for (let suffix = 1; suffix <= WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = getWorktreeCreateCandidate(sanitizedName, suffix)
    effectiveRequestedName = args.name.trim()
      ? getWorktreeCreateCandidate(args.name, suffix)
      : effectiveSanitizedName
    branchName = await resolveCreateBranchNameSsh(
      provider,
      repo.path,
      selectedExistingLocalBranchName ??
        getBranchNameOverrideCandidate(args.branchNameOverride, suffix),
      effectiveSanitizedName,
      settings,
      username
    )
    checkoutExistingBranch = await canCheckoutExistingLocalBranchSsh(
      provider,
      repo.path,
      branchName,
      baseBranch
    )
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      // Why: once a user-selected branch is safe to reuse, path retries should
      // keep that branch exact instead of creating a sibling branch.
      selectedExistingLocalBranchName = branchName
    }
    lastBranchConflictKind = checkoutExistingBranch
      ? null
      : await getSshBranchConflictKind(provider, repo.path, branchName, baseBranch)
    if (lastBranchConflictKind) {
      const selectedReview = isAllowedPushTargetRemoteConflict(
        lastBranchConflictKind,
        branchName,
        args
      )
        ? await getSelectedHostedReviewForBranch(repo, branchName, args).catch(() => null)
        : null
      if (!selectedReview?.matchesSelected) {
        continue
      }
      lastBranchConflictKind = null
    }
    remotePath = computeRemoteWorktreePath(
      effectiveSanitizedName,
      repo.path,
      worktreePathSettings,
      {
        useConfiguredAbsolutePath: hasRepoWorktreeBasePath(repo)
      }
    )
    if (!(await remotePathExists(fsProvider, remotePath))) {
      remotePathResolved = true
      break
    }
  }
  if (!remotePathResolved) {
    if (lastBranchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different worktree name.`
      )
    }
    throw new Error(
      `Could not find an available remote worktree path for "${sanitizedName}". Pick a different worktree name.`
    )
  }

  validateWorkspaceLineageParentBeforeCreate(
    store,
    args.parentWorkspace,
    worktreeWorkspaceKey(`${repo.id}::${remotePath}`)
  )

  const sparseDirectories = args.sparseCheckout
    ? normalizeSparseDirectories(args.sparseCheckout.directories)
    : []
  if (args.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  let sparsePresetId: string | undefined
  if (args.sparseCheckout?.presetId) {
    const preset = store
      .getSparsePresets(repo.id)
      .find((entry) => entry.id === args.sparseCheckout?.presetId)
    if (preset?.repoId === repo.id) {
      try {
        const presetDirectories = normalizeSparseDirectories(preset.directories)
        const presetSet = new Set(presetDirectories)
        const directoriesMatch =
          presetDirectories.length === sparseDirectories.length &&
          sparseDirectories.every((entry) => presetSet.has(entry))
        sparsePresetId = directoriesMatch ? preset.id : undefined
      } catch {
        // Why: corrupt preset data should not block creation or falsely label the new worktree.
      }
    }
  }

  if (remoteTrackingBase) {
    try {
      await refreshRemoteTrackingBaseForWorktreeCreate(provider, repo, remoteTrackingBase)
    } catch {
      throw new Error(
        `Could not refresh base ref "${baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
      )
    }
  } else if (!(await hasRemoteCommitObject(provider, repo.path, baseBranch))) {
    // Why: local or otherwise non-remote-tracking bases preserve legacy
    // best-effort fetch behavior. Verified PR/MR SHA bases already have the
    // commit object locally, so a broad remote fetch only updates unrelated refs.
    const fallbackRemote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
    try {
      await fetchRemoteForWorktreeCreate(provider, repo, fallbackRemote)
    } catch {
      /* best-effort */
    }
  }

  const mux = getActiveMultiplexer(repo.connectionId!)
  if (!mux) {
    throw new Error('SSH connection is not available. Please reconnect and try again.')
  }
  // Why: register before the local-base advisory probe as well as addWorktree.
  // Fresh/older relays may gate generic git.exec calls on registered roots; if
  // the probe runs first it degrades to "no suggestion" even though create works.
  try {
    await Promise.all([
      mux.request('session.registerRoot', { rootPath: repo.path }),
      mux.request('session.registerRoot', { rootPath: remotePath })
    ])
  } catch (err) {
    if (err instanceof Error && err.message.includes('Method not found')) {
      mux.notify('session.registerRoot', { rootPath: repo.path })
      mux.notify('session.registerRoot', { rootPath: remotePath })
    } else {
      throw err
    }
  }

  const localBaseRefRefresh =
    settings.refreshLocalBaseRefOnWorktreeCreate && !checkoutExistingBranch && remoteTrackingBase
      ? await refreshLocalBaseRefForRemoteWorktreeCreate(provider, repo.path, remoteTrackingBase)
      : undefined
  const localBaseRefUpdateSuggestion =
    !settings.refreshLocalBaseRefOnWorktreeCreate &&
    !settings.localBaseRefSuggestionDismissed &&
    !checkoutExistingBranch &&
    remoteTrackingBase
      ? await getRemoteLocalBaseRefUpdateSuggestionForWorktreeCreate(
          provider,
          repo.path,
          remoteTrackingBase
        )
      : undefined

  if (fsProvider) {
    const primaryHooks = await readRemoteEffectiveHooks(repo, fsProvider, repo.path)
    if (primaryHooks?.scripts.setup) {
      shouldRunSetupForCreate(repo, args.setupDecision)
    }
  }

  let preparedPushTarget: GitPushTarget | undefined
  if (args.pushTarget) {
    // Why: fork-PR SSH worktrees need the same contributor-remote setup as
    // local worktrees before creation, otherwise Push/Sync can target origin.
    preparedPushTarget = await prepareWorktreePushTargetSsh(
      provider,
      repo.path,
      args.pushTarget,
      store,
      repo.id
    )
  }

  // Create worktree via relay
  try {
    await timing.time('git_worktree_add', async () =>
      provider.addWorktree(
        repo.path,
        branchName,
        remotePath,
        checkoutExistingBranch
          ? { checkoutExistingBranch }
          : { base: baseBranch, ...(sparseDirectories.length > 0 ? { noCheckout: true } : {}) }
      )
    )
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('No workspace roots registered yet') ||
        err.message.includes('Path outside authorized workspace'))
    ) {
      // Why: only an OLD relay binary (pre-allowlist-removal) can produce
      // these errors. New relays no-op session.registerRoot. Translate the
      // raw error into an actionable upgrade-window message while still
      // preserving the original string for bug reports. Tracked for removal
      // once the relay-version floor moves past the cutover (see
      // docs/relay-fs-allowlist-removal.md).
      throw new Error(
        `Older relay reported an authorization error; please reconnect to deploy the latest relay. (${err.message})`
      )
    }
    throw err
  }
  if (sparseDirectories.length > 0) {
    try {
      // Why: SSH providers expose generic git exec, so the remote sparse flow
      // can mirror local addSparseWorktree without adding a relay method.
      await provider.exec(['sparse-checkout', 'init', '--cone'], remotePath)
      await provider.exec(['sparse-checkout', 'set', '--', ...sparseDirectories], remotePath)
      await provider.exec(['checkout', branchName], remotePath)
    } catch (err) {
      if (!checkoutExistingBranch) {
        await unsetRemoteWorktreeCreationBase(provider, remotePath, branchName)
      }
      await provider
        .removeWorktree(remotePath, true, {
          deleteBranch: !checkoutExistingBranch,
          // Why: sparse setup failed before the user could work in the new
          // branch, so rollback should remove the just-created remote branch.
          forceBranchDelete: !checkoutExistingBranch
        })
        .catch(() => undefined)
      throw err
    }
  }

  // Re-list to get the created worktree info
  const gitWorktrees = await timing.time('list_created_worktree', async () =>
    provider.listWorktrees(repo.path)
  )
  const created = gitWorktrees.find(
    (gw) => gw.branch?.endsWith(branchName) || gw.path.endsWith(effectiveSanitizedName)
  )
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  // Why: PR/MR-created worktrees can start from a head ref/SHA while Source
  // Control must compare against the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  let configuredPushTarget: GitPushTarget | undefined
  if (preparedPushTarget) {
    configuredPushTarget = await configureCreatedWorktreePushTargetSsh(
      provider,
      created.path,
      branchName,
      preparedPushTarget
    )
  }
  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived worktree IDs can be reused after external deletion.
    // Fresh creations must rotate instance identity so stale lineage cannot
    // attach to the new occupant of the same path.
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    lastActivityAt: now,
    // Why: grants the new worktree a short grace window at the top of the
    // Recent sort. During worktree creation (git fetch + add can take several
    // seconds) other worktrees get ambient PTY bumps that would otherwise
    // leave the newly-created one below them; the Recent comparator uses
    // max(lastActivityAt, createdAt + GRACE_MS) to keep it on top until the
    // window elapses. See smart-sort.ts `CREATE_GRACE_MS`.
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'ssh',
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...(requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
        ? { displayName: effectiveRequestedName }
        : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename === true && isTuiAgent(args.createdWithAgent)
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: metadataBaseRef,
          sparsePresetId
        }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  const workspaceLineage = recordWorkspaceLineageForCreatedWorktree(store, args, worktree, now)

  // Why: `experimentalWorktreeSymlinks` is intentionally not wired up for
  // remote (SSH) worktrees. Creating symlinks on the remote host would
  // require a new relay method and authorization surface; the feature is
  // local-only until that protocol work is in scope. Remote repos with
  // `symlinkPaths` configured have them silently ignored here.

  let setup: CreateWorktreeResult['setup']
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  if (fsProvider) {
    await timing.time('prepare_setup', async () => {
      const yamlHooks = await readRemoteOrcaYaml(fsProvider, created.path)
      const hooks = getEffectiveHooksFromConfig(repo, yamlHooks)
      try {
        defaultTabs = getDefaultTabsLaunch(yamlHooks, repo, args.setupDecision)
      } catch (error) {
        // Why: default tab commands share setup's run policy. If the target branch
        // adds commands without a renderer decision, create the tabs but don't run them.
        console.warn(`[hooks] default tab commands skipped for ${created.path}:`, error)
        defaultTabs = yamlHooks?.defaultTabs
          ? { tabs: yamlHooks.defaultTabs, runCommands: false }
          : undefined
      }
      const setupScript = hooks?.scripts.setup
      let shouldLaunchSetup = false
      if (setupScript) {
        try {
          shouldLaunchSetup = shouldRunSetupForCreate(repo, args.setupDecision)
        } catch (error) {
          // Why: the remote worktree already exists. If the created branch adds
          // a setup hook without a renderer decision, skip setup instead of
          // reporting successful git creation as failed.
          console.warn(`[hooks] setup hook skipped for ${created.path}:`, error)
        }
      }
      if (setupScript && shouldLaunchSetup) {
        try {
          setup = await createRemoteSetupRunnerScript(
            repo,
            created.path,
            setupScript,
            provider,
            fsProvider
          )
        } catch (error) {
          console.error(`[hooks] Failed to prepare setup runner for ${created.path}:`, error)
        }
      }
    })
  }

  notifyWorktreesChanged(mainWindow, repo.id)
  return {
    worktree: { ...worktree, workspaceLineage },
    ...(workspaceLineage ? { workspaceLineage } : {}),
    ...(setup ? { setup } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {}),
    timing: timing.finish()
  }
}

export async function createLocalWorktree(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService
): Promise<CreateWorktreeResult> {
  const timing = createWorktreeCreateTimingRecorder()
  const settings = store.getSettings()
  const worktreePathSettings = getWorktreePathSettings(repo, settings)
  const localGitExecOptions = getLocalProjectGitExecOptions(store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }] = hasLocalWorktreeGitOptions
    ? [localWorktreeGitOptions]
    : []
  const addProjectGitOptions = (options?: AddWorktreeOptions): AddWorktreeOptions | undefined => {
    if (!hasLocalWorktreeGitOptions) {
      return options
    }
    return { ...options, ...localWorktreeGitOptions }
  }

  const username = getGitUsername(repo.path)
  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined

  // Why: resolve the base before branch/path selection so remote-tracking bases
  // can be refreshed before `git worktree add`. Creating first and repairing
  // later races setup scripts, agents, and user edits.
  const baseBranch =
    args.baseBranch ||
    repo.worktreeBaseRef ||
    (await resolveDefaultBaseRefViaExec((argv) => gitExecFileAsync(argv, localGitExecOptions)))
  if (!baseBranch) {
    // Why: getDefaultBaseRef may return null when none of origin/HEAD,
    // origin/main, origin/master, local main, or local master exist. Don't
    // fall back to a hardcoded 'origin/main' — passing a non-existent ref to
    // `git worktree add` produces an opaque error. Fail here with a clear
    // message so the UI can prompt the user to pick a base branch explicitly.
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }

  let remoteTrackingBase: RemoteTrackingBase | null = null
  let remoteTrackingRefresh: {
    base: RemoteTrackingBase
    hadLocalBaseRef: boolean
    promise: Promise<RemoteFetchResult>
  } | null = null
  let legacyFetchPromise: Promise<void> | null = null

  if (runtime) {
    remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
      repo.path,
      baseBranch,
      ...localWorktreeGitOptionArgs
    )
    if (remoteTrackingBase) {
      const hasLocalBaseRef = await runtime.hasRemoteTrackingRef(
        repo.path,
        remoteTrackingBase,
        ...localWorktreeGitOptionArgs
      )
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
      remoteTrackingRefresh = {
        base: remoteTrackingBase,
        hadLocalBaseRef: hasLocalBaseRef,
        promise: runtime.getOrStartRemoteTrackingBaseRefresh(
          repo.path,
          remoteTrackingBase,
          ...localWorktreeGitOptionArgs
        )
      }
    } else if (
      !(await hasLocalCommitObjectWithOptions(repo.path, baseBranch, localWorktreeGitOptions))
    ) {
      // Why: when the base branch does not match a configured remote prefix
      // (e.g. plain `main`, `master`, or any local branch), the legacy path
      // still ran a best-effort `git fetch origin`. Verified PR SHA bases
      // already have the needed commit object, so skip that broad fetch.
      const fallbackRemote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
      legacyFetchPromise = runtime
        .fetchRemoteWithCache(repo.path, fallbackRemote, ...localWorktreeGitOptionArgs)
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  } else {
    if (!(await hasLocalCommitObjectWithOptions(repo.path, baseBranch, localWorktreeGitOptions))) {
      const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
      legacyFetchPromise = gitExecFileAsync(['fetch', remote], localGitExecOptions)
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  }
  const workspaceRoot = computeWorkspaceRoot(repo.path, worktreePathSettings)

  // Why: this validation does not depend on remote refs, so it can overlap a
  // required remote-tracking base refresh.
  const primarySetupScript = getEffectiveHooks(repo)?.scripts.setup
  if (primarySetupScript) {
    shouldRunSetupForCreate(repo, args.setupDecision)
  }
  const sparseDirectories = args.sparseCheckout
    ? normalizeSparseDirectories(args.sparseCheckout.directories)
    : []
  if (args.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  let sparsePresetId: string | undefined
  if (args.sparseCheckout?.presetId) {
    const preset = store
      .getSparsePresets(repo.id)
      .find((entry) => entry.id === args.sparseCheckout?.presetId)
    if (preset?.repoId === repo.id) {
      try {
        const presetDirectories = normalizeSparseDirectories(preset.directories)
        // Why: use Set-based comparison so directory order does not affect
        // attribution — matches the renderer's sparseDirectoriesMatch logic.
        const presetSet = new Set(presetDirectories)
        const directoriesMatch =
          presetDirectories.length === sparseDirectories.length &&
          sparseDirectories.every((entry) => presetSet.has(entry))
        sparsePresetId = directoriesMatch ? preset.id : undefined
      } catch {
        // Why: corrupt preset data should not block creation or falsely label the new worktree.
      }
    }
  }

  let effectiveRequestedName = requestedName
  let effectiveSanitizedName = sanitizedName
  let branchName = ''
  let worktreePath = ''

  let resolved = false
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let lastExistingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
  let lastExistingReviewNumber: number | null = null
  // Why: create-from-review can provide an exact branch override that already
  // exists locally; suffix both branch and path instead of blocking the user.
  for (let suffix = 1; suffix <= WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = getWorktreeCreateCandidate(sanitizedName, suffix)
    effectiveRequestedName = requestedName.trim()
      ? getWorktreeCreateCandidate(requestedName, suffix)
      : effectiveSanitizedName
    lastExistingReviewNumber = null

    branchName = await resolveCreateBranchName(
      repo.path,
      selectedExistingLocalBranchName
        ? selectedExistingLocalBranchName
        : getBranchNameOverrideCandidate(args.branchNameOverride, suffix),
      effectiveSanitizedName,
      settings,
      username,
      localWorktreeGitOptions
    )
    checkoutExistingBranch = await canCheckoutExistingLocalBranch(
      repo.path,
      branchName,
      baseBranch,
      localWorktreeGitOptions
    )
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      // Why: suffix retries may need a new path, but an existing branch checkout
      // must keep using the user-selected branch instead of creating a sibling.
      selectedExistingLocalBranchName = branchName
    }
    lastBranchConflictKind = checkoutExistingBranch
      ? null
      : await getBranchConflictKind(repo.path, branchName, baseBranch, localWorktreeGitOptions)
    const allowedPushTargetRemoteConflict =
      lastBranchConflictKind &&
      isAllowedPushTargetRemoteConflict(lastBranchConflictKind, branchName, args)
    if (lastBranchConflictKind) {
      if (allowedPushTargetRemoteConflict) {
        lastExistingPR = null
        let lookupFailed = false
        const selectedReview = getSelectedReviewBranch(args)
        if (selectedReview?.provider === 'github') {
          try {
            lastExistingPR = await getLocalGitHubPrForBranch(
              repo.path,
              branchName,
              localWorktreeGitOptions
            )
          } catch {
            lookupFailed = true
          }
          if (!lookupFailed && isMatchingSelectedGitHubPr(lastExistingPR, args, branchName)) {
            lastBranchConflictKind = null
          } else if (lastExistingPR) {
            lastExistingReviewNumber = lastExistingPR.number
          }
        } else if (selectedReview) {
          let hostedReview: Awaited<ReturnType<typeof getSelectedHostedReviewForBranch>> = null
          try {
            hostedReview = await getSelectedHostedReviewForBranch(repo, branchName, args)
          } catch {
            lookupFailed = true
          }
          if (!lookupFailed && hostedReview?.matchesSelected) {
            lastBranchConflictKind = null
          } else if (hostedReview) {
            lastExistingReviewNumber = hostedReview.number
          }
        }
      }
    }
    if (lastBranchConflictKind) {
      continue
    }

    // Why: `gh pr list` is a network round-trip that previously ran on every
    // create, adding ~1–3s to the happy path even when no conflict exists. We
    // only probe PR conflicts once a local/remote branch collision has already
    // forced us past the first suffix — at that point uniqueness matters
    // enough to justify the GitHub call. The common case (brand-new branch
    // name, no collisions) skips the network entirely.
    if (suffix > 1 && !checkoutExistingBranch) {
      lastExistingPR = null
      try {
        lastExistingPR = await getLocalGitHubPrForBranch(
          repo.path,
          branchName,
          localWorktreeGitOptions
        )
      } catch {
        // GitHub API may be unreachable, rate-limited, or token missing
      }
      if (lastExistingPR && !isMatchingSelectedGitHubPr(lastExistingPR, args, branchName)) {
        lastExistingReviewNumber = lastExistingPR.number
        continue
      }
    }

    worktreePath = ensurePathWithinWorkspace(
      computeWorktreePath(effectiveSanitizedName, repo.path, worktreePathSettings),
      workspaceRoot
    )
    if (existsSync(worktreePath)) {
      continue
    }

    resolved = true
    break
  }

  if (!resolved) {
    // Why: if every suffix in range collides, fall back to the original
    // "reject with a specific reason" behavior so the user sees why creation
    // failed instead of a generic error or (worse) an infinite spinner.
    if (lastExistingReviewNumber !== null) {
      throw new Error(
        `Branch "${branchName}" already has PR #${lastExistingReviewNumber}. Pick a different worktree name.`
      )
    }
    if (lastBranchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different worktree name.`
      )
    }
    throw new Error(
      `Could not find an available worktree name for "${sanitizedName}". Pick a different worktree name.`
    )
  }

  validateWorkspaceLineageParentBeforeCreate(
    store,
    args.parentWorkspace,
    worktreeWorkspaceKey(`${repo.id}::${worktreePath}`)
  )

  if (remoteTrackingRefresh) {
    await timing.time('refresh_base_ref', async () => {
      const result = await remoteTrackingRefresh.promise
      if (!result.ok) {
        throw new Error(
          `Could not refresh base ref "${baseBranch}" from "${remoteTrackingRefresh.base.remote}". Check your network and try again.`
        )
      }
      if (
        !remoteTrackingRefresh.hadLocalBaseRef &&
        !(await runtime?.hasRemoteTrackingRef(
          repo.path,
          remoteTrackingRefresh.base,
          ...localWorktreeGitOptionArgs
        ))
      ) {
        throw new Error(`Base ref "${baseBranch}" was not found after fetching.`)
      }
    })
  }

  if (legacyFetchPromise) {
    await timing.time('refresh_base_ref', async () => {
      await legacyFetchPromise
    })
  }
  emitCreateWorktreeProgress(mainWindow, 'creating', args.creationId)

  let preparedPushTarget: GitPushTarget | undefined
  if (args.pushTarget) {
    // Why: validate and fetch the contributor remote before creating the
    // worktree. If this fails, retrying won't hit branch/path conflicts from a
    // half-created worktree.
    preparedPushTarget = await prepareWorktreePushTarget(
      repo.path,
      args.pushTarget,
      store,
      repo.id,
      localWorktreeGitOptions
    )
  }

  const suggestLocalBaseRefUpdate =
    !settings.refreshLocalBaseRefOnWorktreeCreate &&
    !settings.localBaseRefSuggestionDismissed &&
    Boolean(remoteTrackingBase)
  const remoteTrackingBaseOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
  const existingBranchOption = {
    checkoutExistingBranch,
    ...remoteTrackingBaseOption,
    ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {})
  }
  const addResult: AddWorktreeResult =
    (await timing.time('git_worktree_add', async () => {
      if (sparseDirectories.length > 0) {
        if (checkoutExistingBranch) {
          return addSparseWorktree(
            repo.path,
            worktreePath,
            branchName,
            sparseDirectories,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            addProjectGitOptions(existingBranchOption)
          )
        }
        if (suggestLocalBaseRefUpdate) {
          return addSparseWorktree(
            repo.path,
            worktreePath,
            branchName,
            sparseDirectories,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            addProjectGitOptions({ ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate })
          )
        }
        const sparseOptions = addProjectGitOptions(remoteTrackingBaseOption)
        return sparseOptions
          ? addSparseWorktree(
              repo.path,
              worktreePath,
              branchName,
              sparseDirectories,
              baseBranch,
              settings.refreshLocalBaseRefOnWorktreeCreate,
              sparseOptions
            )
          : addSparseWorktree(
              repo.path,
              worktreePath,
              branchName,
              sparseDirectories,
              baseBranch,
              settings.refreshLocalBaseRefOnWorktreeCreate
            )
      }

      if (checkoutExistingBranch) {
        return addWorktree(
          repo.path,
          worktreePath,
          branchName,
          baseBranch,
          settings.refreshLocalBaseRefOnWorktreeCreate,
          false,
          addProjectGitOptions(existingBranchOption)
        )
      }
      if (suggestLocalBaseRefUpdate) {
        return addWorktree(
          repo.path,
          worktreePath,
          branchName,
          baseBranch,
          settings.refreshLocalBaseRefOnWorktreeCreate,
          false,
          addProjectGitOptions({ ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate })
        )
      }
      const worktreeOptions = addProjectGitOptions(remoteTrackingBaseOption)
      return worktreeOptions
        ? addWorktree(
            repo.path,
            worktreePath,
            branchName,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            false,
            worktreeOptions
          )
        : addWorktree(
            repo.path,
            worktreePath,
            branchName,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate
          )
    })) ?? {}

  let configuredPushTarget: GitPushTarget | undefined
  if (preparedPushTarget) {
    // Why: fork-PR review worktrees should publish commits back to the PR
    // author's branch. Configure the branch upstream immediately so the
    // existing Push/Pull/Sync controls use the contributor remote instead of
    // silently defaulting to origin.
    configuredPushTarget = await configureCreatedWorktreePushTarget(
      worktreePath,
      branchName,
      preparedPushTarget,
      localWorktreeGitOptions
    )
  }

  // Re-list to get the freshly created worktree info
  const gitWorktrees = await timing.time('list_created_worktree', async () =>
    hasLocalWorktreeGitOptions
      ? listWorktrees(repo.path, localWorktreeGitOptions)
      : listWorktrees(repo.path)
  )
  const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  // Why: PR/MR-created worktrees can start from a head ref/SHA while Source
  // Control must compare against the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived worktree IDs can be reused after external deletion.
    // Fresh creations must rotate instance identity so stale lineage cannot
    // attach to the new occupant of the same path.
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    // Stamp activity so the worktree sorts into its final position
    // immediately — prevents scroll-to-reveal racing with a later
    // bumpWorktreeActivity that would re-sort the list.
    lastActivityAt: now,
    // See createRemoteWorktree above: createdAt protects the newly-created
    // worktree from ambient PTY bumps in other worktrees for CREATE_GRACE_MS.
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...(requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
        ? { displayName: effectiveRequestedName }
        : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: metadataBaseRef,
          sparsePresetId
        }
      : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename === true && isTuiAgent(args.createdWithAgent)
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  const workspaceLineage = recordWorkspaceLineageForCreatedWorktree(store, args, worktree, now)
  // Why: creation already paid for `git worktree list`; seed the exact roots
  // now so the next file/git IPC does not lazily rescan and trip macOS privacy
  // prompts for the newly-created workspace.
  registerWorktreeRootsForRepo(store, repo.id, [
    repo.path,
    ...gitWorktrees.map((worktree) => worktree.path)
  ])

  // Why: materialize user-configured paths from the primary checkout into the
  // new worktree before any setup script runs, so scripts that reuse shared
  // state (e.g. `node_modules`, `.env`) see those paths already in place.
  // Gated on the experimental flag so disabling the feature globally skips
  // the work even when a repo still has paths configured.
  const symlinkPaths = repo.symlinkPaths ?? []
  if (settings.experimentalWorktreeSymlinks && symlinkPaths.length > 0) {
    await timing.time('create_symlinks', async () => {
      await createWorktreeLinkedPaths(repo.path, created.path, symlinkPaths)
    })
  }

  // Why: the worktree's own `orca.yaml` (at the tip of the base branch) is
  // authoritative for what runs post-creation. The repo-level trust already
  // granted by the user in the pre-create flow covers execution of that
  // script; we intentionally do not re-gate on content equality with the
  // primary checkout's preview, because benign divergence (whitespace,
  // comments, or any setup-script edit that has landed on the base branch
  // but not yet been pulled into the primary checkout) was silently
  // disabling setup with no UI signal. See #1280 for the original gate and
  // the regression this replaced.
  let setup: CreateWorktreeResult['setup']
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  await timing.time('prepare_setup', async () => {
    const createdYamlHooks = loadHooks(worktreePath)
    const createdEffectiveHooks = getEffectiveHooksFromConfig(repo, createdYamlHooks)
    try {
      defaultTabs = getDefaultTabsLaunch(createdYamlHooks, repo, args.setupDecision)
    } catch (error) {
      // Why: default tab commands share setup's run policy. If the target branch
      // adds commands without a renderer decision, create the tabs but don't run them.
      console.warn(`[hooks] default tab commands skipped for ${worktreePath}:`, error)
      defaultTabs = createdYamlHooks?.defaultTabs
        ? { tabs: createdYamlHooks.defaultTabs, runCommands: false }
        : undefined
    }
    const setupScript = createdEffectiveHooks?.scripts.setup
    let shouldLaunchSetup = false
    if (setupScript) {
      try {
        shouldLaunchSetup = shouldRunSetupForCreate(repo, args.setupDecision)
      } catch (error) {
        // Why: if the target branch introduces setup hooks that the primary
        // checkout did not expose, the renderer may not have collected an ask
        // decision. The worktree already exists, so skip setup instead of
        // turning successful git creation into an IPC failure.
        console.warn(`[hooks] setup hook skipped for ${worktreePath}:`, error)
      }
    }
    if (setupScript && shouldLaunchSetup) {
      try {
        // Why: setup now runs in a visible terminal owned by the renderer so users
        // can inspect failures, answer prompts, and rerun it. The main process only
        // resolves policy and writes the runner script; it must not execute setup
        // itself anymore or we would reintroduce the hidden background-hook behavior.
        //
        // Why: the git worktree already exists at this point. If runner generation
        // fails, surfacing the error as a hard create failure would lie to the UI
        // about the underlying git state and strand a real worktree on disk.
        // Degrade to "created without setup launch" instead.
        setup = createSetupRunnerScript(
          repo,
          worktreePath,
          setupScript,
          ...localWorktreeGitOptionArgs
        )
      } catch (error) {
        console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
      }
    }
  })

  const stagedStartup = await timing.time('spawn_startup_terminal', () =>
    spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree,
      startup: args.startup,
      setup,
      defaultTabs,
      settings,
      createdWithAgent: args.createdWithAgent
    })
  )

  notifyWorktreesChanged(mainWindow, repo.id)
  return {
    worktree: { ...worktree, workspaceLineage },
    ...(workspaceLineage ? { workspaceLineage } : {}),
    ...(stagedStartup.activationSetup
      ? { setup: stagedStartup.activationSetup }
      : setup && !stagedStartup.didSpawnSetup
        ? { setup }
        : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(addResult.localBaseRefRefresh
      ? { localBaseRefRefresh: addResult.localBaseRefRefresh }
      : {}),
    ...(addResult.localBaseRefUpdateSuggestion
      ? { localBaseRefUpdateSuggestion: addResult.localBaseRefUpdateSuggestion }
      : {}),
    ...(stagedStartup.startupTerminal ? { startupTerminal: stagedStartup.startupTerminal } : {}),
    ...(stagedStartup.warning ? { warning: stagedStartup.warning } : {}),
    timing: timing.finish()
  }
}
