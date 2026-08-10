/* eslint-disable max-lines */
// Why: worktree create helpers (local + remote) split out of worktrees.ts; the cohesive create flow runs this file just over the per-file line limit.

import type { BrowserWindow } from 'electron'
import { posix, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  GitPushTarget,
  GitWorktreeInfo,
  GlobalSettings,
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion,
  Repo,
  Worktree,
  WorktreeCreateBaseFallback,
  WorktreeHeadIdentity,
  WorktreeMeta
} from '../../shared/types'
import { getPRForBranch } from '../github/client'
import {
  listWorktrees,
  listWorktreesStrict,
  addWorktree,
  addSparseWorktree,
  rollbackFailedWorktreeCreate,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
} from '../git/worktree'
import type { AddWorktreeOptions, AddWorktreeResult } from '../git/worktree'
import {
  getBranchConflictKind,
  resolveDefaultBaseRefViaExec,
  resolveDefaultBaseRefWithLocalGit
} from '../git/repo'
import { resolveLocalGitUsername, getSshGitUsername } from '../git/git-username'
import { hasCommitObjectViaGitExec } from '../git/commit-object-ref'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree-base-ref'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import type { ForgeProviderId } from '../source-control/forge-provider'
import { validateGitPushTarget } from '../git/push-target-validation'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { gitExecFileAsync } from '../git/runner'
import type {
  OrcaRuntimeService,
  RemoteFetchResult,
  RemoteTrackingBase
} from '../runtime/orca-runtime'
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
  resolveSetupRunnerShell,
  shouldRunSetupForCreate
} from '../hooks'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/tui-agent-config'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { runWorktreeChangeInvalidators } from './worktree-change-invalidators'
import {
  registerOptionalSshWorktreeCreateRoots,
  registerRequiredSshWorktreeCreateRoots
} from './ssh-worktree-create-root-registration'

type CreateWorktreeArgsWithSystemProvenance = CreateWorktreeArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
  cliProvenance?: CliWorkspaceProvenance
}

const UNCERTAIN_SSH_WORKTREE_ADD_RECONCILIATION_GRACE_MS = 1_000
const UNCERTAIN_SSH_WORKTREE_ADD_RECONCILIATION_POLL_MS = 100
import {
  sanitizeWorktreeName,
  sanitizeWorktreeDisplayName,
  computeValidatedBranchName,
  computeWorktreePath,
  computeRemoteWorktreePath,
  computeWorkspaceRoot,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath,
  shouldSetDisplayName,
  mergeWorktree
} from './worktree-logic'
import { findCreatedWorktree } from './created-worktree-reconciliation'
import { areWorktreePathsEqual } from './worktree-path-comparison'
import type { BranchPrefixSettings } from '../../shared/branch-prefix'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  sameGitHubRemoteUrl,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'
import {
  acquireWorktreePushTargetPreparationLease,
  configureCreatedWorktreePushTargetWithExec,
  prepareWorktreePushTargetWithExec
} from './worktree-push-target-setup'
import { isENOENT, registerWorktreeRootsForRepo } from './filesystem-auth'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from './worktree-symlinks'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'
import { resolveWorktreeIncludePaths } from '../git/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../git/worktree-shared-directories'
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
import {
  createWorktreeCreateStageDeadline,
  getEffectiveWorktreeCreateTimeouts
} from '../worktree-create-stage-timeouts'

const SSH_WORKTREE_CREATE_FETCH_FRESHNESS_MS = 30_000
const SSH_WORKTREE_CREATE_FETCH_CACHE_MAX = 512
// Why: bound the fallback `git fetch origin` so a Windows credential-manager GUI hang (STA-1292) can't wedge worktree creation forever.
const CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS = 60_000
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

type RemainingWorktreeCreateStageMs = () => number

function appendWorktreeCreateWarning(current: string | undefined, next: string): string {
  return current ? `${current} Also ${next[0]?.toLowerCase() ?? ''}${next.slice(1)}` : next
}

function appendFailedWorktreeCreateCleanupMessage(error: unknown, worktreePath: string): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error))
  wrapped.message = `${wrapped.message} (cleanup also failed — the partially created worktree at "${worktreePath}" may need manual removal)`
  return wrapped
}

function isUncertainRemoteWorktreeAddError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as Error & { code?: unknown }).code
  return (
    error.name === 'AbortError' ||
    error.message.toLowerCase().includes('timed out') ||
    code === 'ETIMEDOUT' ||
    code === 'CONNECTION_LOST' ||
    code === 'SSH_MUX_REQUEST_TIMEOUT'
  )
}

function getSetupRunnerCommandPlatformForLaunch(
  setup: CreateWorktreeResult['setup'],
  fallbackPlatform: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallbackPlatform)
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
    const platform = getSetupRunnerCommandPlatformForLaunch(
      setup,
      process.platform === 'win32' ? 'windows' : 'posix'
    )
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup.command,
      platform,
      shell: setup.shell
    })
    sequencedStartup = {
      ...startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommandStr = sequenced.setupCommand
  }

  try {
    // Why: only after `git worktree add` + metadata registration is the path safe for a runtime PTY to boot the agent while setup runs alongside.
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
      ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
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
          getSetupRunnerCommandPlatformForLaunch(
            setup,
            process.platform === 'win32' ? 'windows' : 'posix'
          ),
          setup.shell
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

function waitForSshWorktreeCreateOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return operation
  }
  if (signal.aborted) {
    return Promise.reject(
      Object.assign(new Error('Worktree creation was cancelled.'), {
        name: 'AbortError'
      })
    )
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(Object.assign(new Error('Worktree creation was cancelled.'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function throwIfWorktreeCreateAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('Worktree creation was cancelled.'), { name: 'AbortError' })
  }
}

async function getOrStartSshWorktreeCreateFetch(
  freshnessKey: string,
  inflightKey: string,
  queueKey: string,
  fetch: () => Promise<void>
): Promise<void> {
  if (getFreshSshWorktreeCreateFetchCompletedAt(freshnessKey) !== null) {
    return
  }
  const existing = sshWorktreeCreateFetchInflight.get(inflightKey)
  if (existing) {
    return existing
  }
  const promise = enqueueSshWorktreeCreateFetch(queueKey, async () => {
    if (getFreshSshWorktreeCreateFetchCompletedAt(freshnessKey) !== null) {
      return
    }
    await fetch()
    // Why: SSH creation has no OrcaRuntimeService to share; still reuse recent fetches for repeated creates on the same target.
    rememberSshWorktreeCreateFetchCompletedAt(freshnessKey)
  }).finally(() => {
    if (sshWorktreeCreateFetchInflight.get(inflightKey) === promise) {
      sshWorktreeCreateFetchInflight.delete(inflightKey)
    }
  })
  sshWorktreeCreateFetchInflight.set(inflightKey, promise)
  return promise
}

async function refreshRemoteTrackingBaseForWorktreeCreate(
  provider: SshGitProvider,
  repo: Repo,
  base: RemoteTrackingBase,
  timeoutMs = CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS,
  remainingTimeoutMs: RemainingWorktreeCreateStageMs = () => timeoutMs,
  signal?: AbortSignal
): Promise<void> {
  const fetchKey = getSshWorktreeCreateBaseFetchKey(repo, base)
  return waitForSshWorktreeCreateOperation(
    getOrStartSshWorktreeCreateFetch(
      fetchKey,
      `${fetchKey}::${timeoutMs}`,
      getSshWorktreeCreateRemoteQueueKey(repo, base.remote),
      () =>
        // Why: the exact-base refresh gates create; unrelated repo housekeeping must not extend it.
        provider.fetchRemoteTrackingRef(repo.path, base.remote, base.branch, base.ref, {
          skipAutoMaintenance: true,
          timeoutMs: remainingTimeoutMs()
        })
    ),
    signal
  )
}

async function fetchRemoteForWorktreeCreate(
  provider: SshGitProvider,
  repo: Repo,
  remote: string,
  timeoutMs = CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS,
  remainingTimeoutMs: RemainingWorktreeCreateStageMs = () => timeoutMs,
  signal?: AbortSignal
): Promise<void> {
  const fetchKey = getSshWorktreeCreateRemoteFetchKey(repo, remote)
  return waitForSshWorktreeCreateOperation(
    getOrStartSshWorktreeCreateFetch(
      fetchKey,
      `${fetchKey}::${timeoutMs}`,
      getSshWorktreeCreateRemoteQueueKey(repo, remote),
      () =>
        provider
          .exec(['fetch', remote], repo.path, { timeoutMs: remainingTimeoutMs() })
          .then(() => undefined)
    ),
    signal
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
    // Best-effort cleanup; keep the sparse setup error as the actionable failure.
  }
}

async function rollbackFailedRemoteWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  worktreePath: string,
  branchName: string,
  checkoutExistingBranch: boolean,
  waitForLateRegistration = false
): Promise<boolean> {
  const reconciliationDeadlineAt = waitForLateRegistration
    ? Date.now() + UNCERTAIN_SSH_WORKTREE_ADD_RECONCILIATION_GRACE_MS
    : Date.now()
  let created: GitWorktreeInfo | undefined
  do {
    const worktrees = await provider.listWorktrees(repoPath, {
      timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
      strict: true
    })
    created = findRemoteWorktreeCreateIdentity(provider, worktrees, worktreePath, branchName)
    if (created) {
      break
    }
    if (
      !waitForLateRegistration ||
      worktrees.some((worktree) => worktree.branch === `refs/heads/${branchName}`) ||
      Date.now() >= reconciliationDeadlineAt
    ) {
      return false
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(
          UNCERTAIN_SSH_WORKTREE_ADD_RECONCILIATION_POLL_MS,
          reconciliationDeadlineAt - Date.now()
        )
      )
    )
  } while (Date.now() < reconciliationDeadlineAt)
  if (!created) {
    return false
  }
  if (!checkoutExistingBranch) {
    await unsetRemoteWorktreeCreationBase(provider, created.path, branchName)
  }
  await provider.removeWorktree(created.path, true, {
    deleteBranch: !checkoutExistingBranch,
    forceBranchDelete: !checkoutExistingBranch,
    timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  })
  return true
}

function findRemoteWorktreeCreateIdentity(
  provider: SshGitProvider,
  worktrees: readonly GitWorktreeInfo[],
  worktreePath: string,
  branchName: string
): GitWorktreeInfo | undefined {
  const remotePlatform = provider.getHostPlatform?.()?.os ?? process.platform
  return worktrees.find(
    (worktree) =>
      areWorktreePathsEqual(worktree.path, worktreePath, remotePlatform) &&
      worktree.branch === `refs/heads/${branchName}`
  )
}

async function resolveCreateBranchName(
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: BranchPrefixSettings,
  username: string | null,
  gitOptions: { wslDistro?: string } = {}
): Promise<string> {
  if (!branchNameOverride) {
    return computeValidatedBranchName(sanitizedName, settings, username)
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
  settings: BranchPrefixSettings,
  username: string | null
): Promise<string> {
  if (!branchNameOverride) {
    return computeValidatedBranchName(sanitizedName, settings, username)
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

async function hasLocalWorktreeBaseRefWithOptions(
  repoPath: string,
  baseRef: string,
  gitOptions: { wslDistro?: string }
): Promise<boolean> {
  const refExists = async (qualifiedRef: string) => {
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`],
        {
          cwd: repoPath,
          ...gitOptions
        }
      )
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasLocalCommitObjectWithOptions(repoPath, baseRef, gitOptions)
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
  ref: string,
  remainingTimeoutMs?: RemainingWorktreeCreateStageMs
): Promise<boolean> {
  return hasCommitObjectViaGitExec(
    (gitArgs) =>
      provider.exec(
        gitArgs,
        repoPath,
        remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : undefined
      ),
    ref
  ).then((found) => {
    if (!found) {
      remainingTimeoutMs?.()
    }
    return found
  })
}

async function hasRemoteWorktreeBaseRef(
  provider: SshGitProvider,
  repoPath: string,
  baseRef: string,
  remainingTimeoutMs?: RemainingWorktreeCreateStageMs
): Promise<boolean> {
  const refExists = (qualifiedRef: string) =>
    hasRemoteTrackingRefSsh(provider, repoPath, qualifiedRef, remainingTimeoutMs)
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasRemoteCommitObject(provider, repoPath, baseRef, remainingTimeoutMs)
}

// Why: hasRemoteCommitObject resolves only SHAs, not symbolic remote-tracking refs; detect those directly for the fetch-failed local fallback.
async function hasRemoteTrackingRefSsh(
  provider: SshGitProvider,
  repoPath: string,
  ref: string,
  remainingTimeoutMs?: RemainingWorktreeCreateStageMs
): Promise<boolean> {
  try {
    const { stdout } = await provider.exec(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      repoPath,
      remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : undefined
    )
    return stdout.trim().length > 0
  } catch {
    remainingTimeoutMs?.()
    return false
  }
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
      // Why: `git branch --all --list feature/x` doesn't match `remotes/origin/feature/x`; parse remote refs directly.
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
  gitOptions: { wslDistro?: string; signal?: AbortSignal } = {},
  remainingTimeoutMs: () => number = () => CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS
): Promise<GitPushTarget> {
  const execGit: GitRemoteExec = (args, cwd) =>
    gitExecFileAsync(args, { cwd, ...gitOptions, timeout: remainingTimeoutMs() })
  await validateGitPushTarget(repoPath, target, {
    ...gitOptions,
    timeout: remainingTimeoutMs()
  })
  return prepareWorktreePushTargetWithExec(
    execGit,
    repoPath,
    target,
    (existingRemote) =>
      store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            { ...target, remoteName: existingRemote },
            repoId
          )
        : false,
    (args, cwd) =>
      gitExecFileAsync(args, {
        cwd,
        timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
        ...(gitOptions.wslDistro ? { wslDistro: gitOptions.wslDistro } : {})
      }),
    (remoteName) =>
      gitExecFileAsync(
        [
          'fetch',
          remoteName,
          `+refs/heads/${target.branchName}:refs/remotes/${remoteName}/${target.branchName}`
        ],
        {
          cwd: repoPath,
          ...gitOptions,
          timeout: remainingTimeoutMs()
        }
      ).then(() => undefined)
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
  gitOptions: { wslDistro?: string; timeout?: number } = {}
): Promise<GitPushTarget> {
  return configureCreatedWorktreePushTargetWithExec(
    (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
    worktreePath,
    branchName,
    target
  )
}

async function prepareWorktreePushTargetSsh(
  provider: SshGitProvider,
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string,
  remainingTimeoutMs: () => number = () => CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<GitPushTarget> {
  assertGitPushTargetShape(target)
  await provider.awaitPushTargetRemoteMutations?.(repoPath, {
    timeoutMs: remainingTimeoutMs(),
    signal
  })
  const execGit: GitRemoteExec = (args, cwd) =>
    provider.exec(args, cwd, { timeoutMs: remainingTimeoutMs(), signal })
  const cleanupExecGit: GitRemoteExec = (args, cwd) =>
    provider.exec(args, cwd, { timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS })
  await execGit(['check-ref-format', '--branch', target.branchName], repoPath)
  return prepareWorktreePushTargetWithExec(
    execGit,
    repoPath,
    target,
    (existingRemote) =>
      store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            { ...target, remoteName: existingRemote },
            repoId
          )
        : false,
    cleanupExecGit,
    (remoteName) =>
      provider.fetchRemoteTrackingRef(
        repoPath,
        remoteName,
        target.branchName,
        `refs/remotes/${remoteName}/${target.branchName}`,
        { timeoutMs: remainingTimeoutMs(), signal }
      )
  )
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
  // Why: SSH terminals choose their shell on the remote host; local Windows
  // preferences cannot safely select a remote runner format or launch command.
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

async function resolveRemoteWorktreeCreateBasePlan(
  provider: SshGitProvider,
  repo: Repo,
  requestedBaseBranch: string | undefined
): Promise<RemoteWorktreeCreateBasePlan | null> {
  const baseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () =>
      resolveDefaultBaseRefViaExec((argv) => provider.exec(argv, repo.path)),
    isBaseUsable: async (baseBranchCandidate) => {
      const remoteTrackingBase = await resolveRemoteTrackingBaseSsh(
        provider,
        repo.path,
        baseBranchCandidate
      )
      if (remoteTrackingBase) {
        if (await hasRemoteTrackingRefSsh(provider, repo.path, remoteTrackingBase.ref)) {
          return true
        }
        return hasRemoteWorktreeBaseRef(provider, repo.path, baseBranchCandidate)
      }
      return hasRemoteWorktreeBaseRef(provider, repo.path, baseBranchCandidate)
    }
  })
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
  // Why: base-plan probes use generic git.exec, and some relays require the repo root registered before probes can see refs.
  await registerOptionalSshWorktreeCreateRoots(repo.connectionId!, [repo.path])
  const basePlan = await getOrStartRemoteWorktreeCreateBasePlan(provider, repo, args.baseBranch)
  if (!basePlan) {
    return
  }
  if (basePlan.remoteTrackingBase) {
    if (
      (await hasRemoteTrackingRefSsh(provider, repo.path, basePlan.remoteTrackingBase.ref)) ||
      !(await hasRemoteWorktreeBaseRef(provider, repo.path, basePlan.baseBranch))
    ) {
      await refreshRemoteTrackingBaseForWorktreeCreate(provider, repo, basePlan.remoteTrackingBase)
      return
    }
  }
  if (await hasRemoteWorktreeBaseRef(provider, repo.path, basePlan.baseBranch)) {
    // Why: PR/MR resolvers already fetched verified SHA start points; a broad fetch only updates unrelated refs.
    return
  }

  // Why: mirrors createRemoteWorktree's legacy local-base fallback so prefetch and create share one process-local SSH fetch cache.
  await fetchRemoteForWorktreeCreate(provider, repo, 'origin')
}

async function refreshLocalBaseRefForRemoteWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase,
  remainingTimeoutMs?: RemainingWorktreeCreateStageMs
): Promise<LocalBaseRefRefreshResult> {
  const evaluation = await evaluateRemoteLocalBaseRefRefreshability(
    provider,
    repoPath,
    remoteTrackingBase,
    () => true,
    remainingTimeoutMs
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
      ...(evaluation.ownerWorktreePath ? { ownerWorktreePath: evaluation.ownerWorktreePath } : {}),
      ...(remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : {})
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
  remoteTrackingBase: RemoteTrackingBase,
  shouldInspectOwner: (behind: number) => boolean = () => true,
  remainingTimeoutMs?: RemainingWorktreeCreateStageMs
): Promise<RemoteLocalBaseRefRefreshability> {
  const resultBase = {
    baseRef: remoteTrackingBase.base,
    localBranch: remoteTrackingBase.branch
  }
  const fullRef = `refs/heads/${remoteTrackingBase.branch}`

  let behind = 0
  try {
    // Why: SSH generic git.exec is allowlisted — merge-base and log are permitted read-only probes; rev-list is intentionally not exposed.
    await provider.exec(
      ['merge-base', '--is-ancestor', fullRef, remoteTrackingBase.ref],
      repoPath,
      remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : undefined
    )
    const { stdout } = await provider.exec(
      ['log', '--format=%H', `${fullRef}..${remoteTrackingBase.ref}`],
      repoPath,
      remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : undefined
    )
    behind = countNonEmptyGitOutputLines(stdout)
    if (!shouldInspectOwner(behind)) {
      // Why: no behind commits means no update to advise; skip remote worktree/status round trips.
      return {
        refreshable: true,
        ...resultBase,
        fullRef,
        remoteTrackingRef: remoteTrackingBase.ref,
        behind
      }
    }
  } catch {
    remainingTimeoutMs?.()
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    const worktrees = await provider.listWorktrees(
      repoPath,
      remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : undefined
    )
    const ownerWorktree = worktrees.find((wt) => wt.branch === fullRef)

    if (ownerWorktree) {
      const status = await provider.worktreeIsClean(ownerWorktree.path, {
        includeUntracked: false,
        ...(remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : {})
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

    // Why: not checked out anywhere, so a bare-ref fast-forward is safe; omitting ownerWorktreePath tells the relay to update-ref, not reset --hard.
    return {
      refreshable: true,
      ...resultBase,
      fullRef,
      remoteTrackingRef: remoteTrackingBase.ref,
      behind
    }
  } catch {
    remainingTimeoutMs?.()
    return { refreshable: false, result: { ...resultBase, status: 'skipped_error' } }
  }
}

async function getRemoteLocalBaseRefUpdateSuggestionForWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase,
  remainingTimeoutMs?: RemainingWorktreeCreateStageMs
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateRemoteLocalBaseRefRefreshability(
    provider,
    repoPath,
    remoteTrackingBase,
    (behind) => behind > 0,
    remainingTimeoutMs
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
      checkOnly: true,
      ...(remainingTimeoutMs ? { timeoutMs: remainingTimeoutMs() } : {})
    })
  } catch {
    remainingTimeoutMs?.()
    return undefined
  }
  return {
    baseRef: evaluation.baseRef,
    localBranch: evaluation.localBranch,
    behind: evaluation.behind
  }
}

export function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  // Why: invalidate detected-worktree caches before renderer observers react, so follow-up listDetected sees post-change state.
  runWorktreeChangeInvalidators(repoId)
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

export function notifyWorktreeGitStatusMetadataChanged(
  mainWindow: BrowserWindow,
  repoId: string
): void {
  // Why: index churn is a Source Control freshness hint, not a graph mutation; leave structural caches and runtime/mobile events untouched.
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:gitStatusMetadataChanged', { repoId })
  }
}

export function notifyWorktreeHeadIdentitiesChanged(
  mainWindow: BrowserWindow,
  repoId: string,
  identities: WorktreeHeadIdentity[]
): void {
  // Why: background worktrees have no active status refresh, so metadata-detected head moves ride this targeted event instead of the structural fanout.
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:headIdentitiesChanged', { repoId, identities })
  }
}

// Why: two-phase spinner — fire 'fetching' before pre-create fetch and 'creating' before git worktree add so the renderer can swap its label.
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
  mainWindow: BrowserWindow,
  options: { signal?: AbortSignal } = {}
): Promise<CreateWorktreeResult> {
  const { signal } = options
  throwIfWorktreeCreateAborted(signal)
  const timing = createWorktreeCreateTimingRecorder()
  const provider = requireSshGitProvider(repo.connectionId!)
  const fsProvider = getSshFilesystemProvider(repo.connectionId!)

  const settings = store.getSettings()
  const createTimeouts = getEffectiveWorktreeCreateTimeouts(repo, settings, args.timeouts)
  const worktreePathSettings = getWorktreePathSettings(repo, settings)
  let effectiveRequestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  let effectiveSanitizedName = sanitizedName
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined

  // Why: base resolution probes refs via generic git.exec; register the repo root first so relays don't report a valid base as stale.
  await registerRequiredSshWorktreeCreateRoots(repo.connectionId!, [repo.path])

  // Why: explicit branches and non-username prefix modes never consume this; skipping the remote probe preserves the exact branch name.
  const username =
    !args.branchNameOverride && settings.branchPrefix === 'git-username'
      ? await getSshGitUsername(provider, repo.path)
      : ''

  const branchConflictSubject = args.branchNameOverride ? 'branch name' : 'worktree name'
  // Why: don't fall back to hardcoded 'origin/main'; it may not exist (master/develop) and yields an opaque git error, so fail clearly and let the UI prompt.
  const basePlan = await getOrStartRemoteWorktreeCreateBasePlan(provider, repo, args.baseBranch)
  if (!basePlan) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }
  let { baseBranch } = basePlan
  let { remoteTrackingBase } = basePlan
  let baseFallback: WorktreeCreateBaseFallback | undefined

  if (remoteTrackingBase) {
    const hasRemoteTrackingBaseRef = await hasRemoteTrackingRefSsh(
      provider,
      repo.path,
      remoteTrackingBase.ref
    )
    const hasNamedLocalBaseRef = await hasRemoteWorktreeBaseRef(provider, repo.path, baseBranch)
    const hasFallbackLocalBaseRef =
      !hasNamedLocalBaseRef &&
      (await hasRemoteWorktreeBaseRef(provider, repo.path, remoteTrackingBase.branch))
    if (!hasRemoteTrackingBaseRef && (hasNamedLocalBaseRef || hasFallbackLocalBaseRef)) {
      // Why: branch reuse and conflict checks must see the local fallback too.
      if (hasFallbackLocalBaseRef) {
        baseBranch = remoteTrackingBase.branch
      }
      baseFallback = {
        requestedRef: remoteTrackingBase.base,
        localRef: baseBranch
      }
      remoteTrackingBase = null
    }
  }

  let branchName = ''
  let checkoutExistingBranch = false
  let remotePath = ''
  let selectedExistingLocalBranchName: string | null = null
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let remotePathResolved = false
  // Why: duplicate PR/MR checkouts still need a workspace; suffix branch/path while preserving review metadata and push target.
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
      // Why: once a user-selected branch is safe to reuse, path retries keep it exact instead of creating a sibling.
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
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different ${branchConflictSubject}.`
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

  // Why: addWorktree/setup probes run inside the new path; older relays need that root registered before accepting git/fs ops there.
  await registerRequiredSshWorktreeCreateRoots(repo.connectionId!, [remotePath])

  const { remainingMs: remainingRefreshMs } = createWorktreeCreateStageDeadline(
    createTimeouts.refreshBaseRefMs,
    `Worktree base ref refresh timed out after ${createTimeouts.refreshBaseRefMs}ms.`
  )
  if (remoteTrackingBase) {
    try {
      await refreshRemoteTrackingBaseForWorktreeCreate(
        provider,
        repo,
        remoteTrackingBase,
        createTimeouts.refreshBaseRefMs,
        remainingRefreshMs,
        signal
      )
    } catch {
      throwIfWorktreeCreateAborted(signal)
      // Why: a refresh failure shouldn't block create if a usable (stale) local base ref exists; probe after registerRoot and hard-fail only when none does.
      if (
        !(await hasRemoteTrackingRefSsh(
          provider,
          repo.path,
          remoteTrackingBase.ref,
          remainingRefreshMs
        ))
      ) {
        throw new Error(
          `Could not refresh base ref "${baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
        )
      }
    }
  } else if (
    !(await hasRemoteWorktreeBaseRef(provider, repo.path, baseBranch, remainingRefreshMs))
  ) {
    // Why: non-remote-tracking bases keep the legacy best-effort fetch; verified PR/MR SHA bases already have the object, so a broad fetch is wasted.
    try {
      await fetchRemoteForWorktreeCreate(
        provider,
        repo,
        'origin',
        createTimeouts.refreshBaseRefMs,
        remainingRefreshMs,
        signal
      )
    } catch {
      throwIfWorktreeCreateAborted(signal)
      remainingRefreshMs()
    }
  }

  const localBaseRefRefresh =
    settings.refreshLocalBaseRefOnWorktreeCreate && !checkoutExistingBranch && remoteTrackingBase
      ? await refreshLocalBaseRefForRemoteWorktreeCreate(
          provider,
          repo.path,
          remoteTrackingBase,
          remainingRefreshMs
        )
      : undefined
  const localBaseRefUpdateSuggestion =
    !settings.refreshLocalBaseRefOnWorktreeCreate &&
    !settings.localBaseRefSuggestionDismissed &&
    !checkoutExistingBranch &&
    remoteTrackingBase
      ? await getRemoteLocalBaseRefUpdateSuggestionForWorktreeCreate(
          provider,
          repo.path,
          remoteTrackingBase,
          remainingRefreshMs
        )
      : undefined

  if (fsProvider) {
    const primaryHooks = await readRemoteEffectiveHooks(repo, fsProvider, repo.path)
    if (primaryHooks?.scripts.setup) {
      shouldRunSetupForCreate(repo, args.setupDecision)
    }
  }

  const addCheckoutDeadline = createWorktreeCreateStageDeadline(
    createTimeouts.addCheckoutMs,
    `Worktree add and checkout timed out after ${createTimeouts.addCheckoutMs}ms.`
  )
  let preparedPushTarget: GitPushTarget | undefined
  const releasePushTargetPreparation = args.pushTarget
    ? await acquireWorktreePushTargetPreparationLease(repo.path, args.pushTarget, {
        remainingTimeoutMs: addCheckoutDeadline.remainingMs,
        signal
      })
    : undefined
  if (args.pushTarget) {
    // Why: fork-PR SSH worktrees need contributor-remote setup before create, else Push/Sync target origin.
    try {
      preparedPushTarget = await prepareWorktreePushTargetSsh(
        provider,
        repo.path,
        args.pushTarget,
        store,
        repo.id,
        addCheckoutDeadline.remainingMs,
        signal
      )
    } catch (error) {
      releasePushTargetPreparation?.()
      throw error
    }
  }

  let created: GitWorktreeInfo
  let configuredPushTarget: GitPushTarget | undefined
  let addAttempted = false
  let addCompleted = false
  try {
    throwIfWorktreeCreateAborted(signal)
    try {
      addAttempted = true
      await timing.time('git_worktree_add', async () =>
        provider.addWorktree(
          repo.path,
          branchName,
          remotePath,
          checkoutExistingBranch
            ? {
                checkoutExistingBranch,
                timeoutMs: addCheckoutDeadline.remainingMs(),
                signal
              }
            : {
                base: baseBranch,
                ...(sparseDirectories.length > 0 ? { noCheckout: true } : {}),
                timeoutMs: addCheckoutDeadline.remainingMs(),
                signal
              }
        )
      )
      addCompleted = true
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('No workspace roots registered yet') ||
          error.message.includes('Path outside authorized workspace'))
      ) {
        // Why: only OLD relays (pre-allowlist-removal) throw these; surface an upgrade message. Remove after version floor moves (docs/relay-fs-allowlist-removal.md).
        throw new Error(
          `Older relay reported an authorization error; please reconnect to deploy the latest relay. (${error.message})`
        )
      }
      throw error
    }

    if (sparseDirectories.length > 0) {
      // Why: SSH providers expose generic git exec, so remote sparse mirrors local addSparseWorktree without a new relay method.
      await provider.exec(['sparse-checkout', 'init', '--cone'], remotePath, {
        timeoutMs: addCheckoutDeadline.remainingMs(),
        signal
      })
      await provider.exec(['sparse-checkout', 'set', '--', ...sparseDirectories], remotePath, {
        timeoutMs: addCheckoutDeadline.remainingMs(),
        signal
      })
      await provider.exec(['checkout', branchName], remotePath, {
        timeoutMs: addCheckoutDeadline.remainingMs(),
        signal
      })
    }

    const registrationDeadline = createWorktreeCreateStageDeadline(
      createTimeouts.registrationMs,
      `Worktree registration timed out after ${createTimeouts.registrationMs}ms.`
    )
    const gitWorktrees = await timing.time('list_created_worktree', async () =>
      provider.listWorktrees(repo.path, {
        timeoutMs: registrationDeadline.remainingMs(),
        strict: true,
        signal
      })
    )
    const reconciled = findCreatedWorktree(
      gitWorktrees,
      remotePath,
      branchName,
      provider.getHostPlatform?.()?.os ?? process.platform
    )
    if (!reconciled) {
      throw new Error('Worktree created but not found in listing')
    }
    created = reconciled
    if (preparedPushTarget) {
      configuredPushTarget = await configureCreatedWorktreePushTargetWithExec(
        (args, cwd) =>
          provider.exec(args, cwd, {
            timeoutMs: registrationDeadline.remainingMs(),
            signal
          }),
        created.path,
        branchName,
        preparedPushTarget
      )
    }
  } catch (error) {
    if (!addAttempted || (!addCompleted && !isUncertainRemoteWorktreeAddError(error))) {
      await cleanupUnusedWorktreePushTargetRemoteSsh(
        provider,
        repo.path,
        `${repo.id}::${remotePath}`,
        preparedPushTarget,
        store
      )
      releasePushTargetPreparation?.()
      throw error
    }
    try {
      await rollbackFailedRemoteWorktreeCreate(
        provider,
        repo.path,
        remotePath,
        branchName,
        checkoutExistingBranch,
        !addCompleted
      )
    } catch (cleanupError) {
      console.warn(`[worktree-create] Failed to roll back remote "${remotePath}"`, cleanupError)
      releasePushTargetPreparation?.()
      throw appendFailedWorktreeCreateCleanupMessage(error, remotePath)
    }
    await cleanupUnusedWorktreePushTargetRemoteSsh(
      provider,
      repo.path,
      `${repo.id}::${remotePath}`,
      preparedPushTarget,
      store
    )
    releasePushTargetPreparation?.()
    throw error
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  // Why: PR/MR worktrees start from a head ref/SHA but Source Control must compare against the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived IDs get reused after external deletion; rotate instance identity so stale lineage can't attach to the new occupant.
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    lastActivityAt: now,
    // Why: grace window atop Recent so ambient PTY bumps on others during create don't bury the new worktree. See smart-sort.ts `CREATE_GRACE_MS`.
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'ssh',
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
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
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = (() => {
    try {
      return timing.timeSync('persist_metadata', () => {
        const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
        return { worktree: mergeWorktree(repo.id, created, meta) }
      })
    } finally {
      releasePushTargetPreparation?.()
    }
  })()
  const workspaceLineage = recordWorkspaceLineageForCreatedWorktree(store, args, worktree, now)

  // Why: shared/symlink paths, `orca.yaml` shared directories, and `.worktreeinclude` copies are local-only; remote (SSH) support needs a new relay method + auth surface, so all are skipped here.

  let setup: CreateWorktreeResult['setup']
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  if (fsProvider) {
    await timing.time('prepare_setup', async () => {
      const yamlHooks = await readRemoteOrcaYaml(fsProvider, created.path)
      const hooks = getEffectiveHooksFromConfig(repo, yamlHooks)
      try {
        defaultTabs = getDefaultTabsLaunch(yamlHooks, repo, args.setupDecision)
      } catch (error) {
        // Why: default tab commands share setup's run policy; without a renderer decision, create the tabs but don't run them.
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
          // Why: worktree already exists; skip setup rather than fail a successful git create when the branch adds a hook without a renderer decision.
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
    ...(baseFallback ? { baseFallback } : {}),
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
  const createTimeouts = getEffectiveWorktreeCreateTimeouts(repo, settings, args.timeouts)
  const worktreePathSettings = getWorktreePathSettings(repo, settings)
  const localGitExecOptions = getLocalProjectGitExecOptions(store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }] = hasLocalWorktreeGitOptions
    ? [localWorktreeGitOptions]
    : []
  let refreshDeadline: ReturnType<typeof createWorktreeCreateStageDeadline> | undefined
  const remainingRefreshMs = (): number => {
    refreshDeadline ??= createWorktreeCreateStageDeadline(
      createTimeouts.refreshBaseRefMs,
      `Worktree base ref refresh timed out after ${createTimeouts.refreshBaseRefMs}ms.`
    )
    return refreshDeadline.remainingMs()
  }
  const addRefreshTimeoutMs = (): number =>
    refreshDeadline?.remainingMs() ?? createTimeouts.refreshBaseRefMs
  let addRefreshTimeout = createTimeouts.refreshBaseRefMs
  let addCheckoutDeadline: ReturnType<typeof createWorktreeCreateStageDeadline> | undefined
  const remainingAddCheckoutMs = (): number => {
    addCheckoutDeadline ??= createWorktreeCreateStageDeadline(
      createTimeouts.addCheckoutMs,
      `Worktree add and checkout timed out after ${createTimeouts.addCheckoutMs}ms.`
    )
    return addCheckoutDeadline.remainingMs()
  }
  const addProjectGitOptions = (options?: AddWorktreeOptions): AddWorktreeOptions | undefined => {
    return {
      ...options,
      ...localWorktreeGitOptions,
      refreshTimeout: addRefreshTimeout,
      timeout: remainingAddCheckoutMs()
    }
  }

  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined
  // Why: explicit branches and non-username prefix modes never consume this; skipping the probe preserves the exact generated branch name.
  const username =
    !args.branchNameOverride && settings.branchPrefix === 'git-username'
      ? await resolveLocalGitUsername(repo.path)
      : ''

  let baseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch: args.baseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () => resolveDefaultBaseRefWithLocalGit(localGitExecOptions),
    isBaseUsable: async (baseBranchCandidate) => {
      if (runtime) {
        const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
          repo.path,
          baseBranchCandidate,
          ...localWorktreeGitOptionArgs
        )
        if (remoteTrackingBase) {
          if (
            await runtime.hasRemoteTrackingRef(
              repo.path,
              remoteTrackingBase,
              ...localWorktreeGitOptionArgs
            )
          ) {
            return true
          }
          return hasLocalWorktreeBaseRefWithOptions(
            repo.path,
            baseBranchCandidate,
            localGitExecOptions
          )
        }
      }
      return hasLocalWorktreeBaseRefWithOptions(repo.path, baseBranchCandidate, localGitExecOptions)
    }
  })
  if (!baseBranch) {
    // Why: no default base resolved; fail clearly rather than pass a hardcoded non-existent ref to git worktree add (opaque error) so the UI can prompt.
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }

  let remoteTrackingBase: RemoteTrackingBase | null = null
  let baseFallback: WorktreeCreateBaseFallback | undefined
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
      const hasRemoteTrackingBaseRef = await runtime.hasRemoteTrackingRef(
        repo.path,
        remoteTrackingBase,
        ...localWorktreeGitOptionArgs
      )
      const hasNamedLocalBaseRef = await hasLocalWorktreeBaseRefWithOptions(
        repo.path,
        baseBranch,
        localGitExecOptions
      )
      const hasFallbackLocalBaseRef =
        !hasNamedLocalBaseRef &&
        (await hasLocalWorktreeBaseRefWithOptions(
          repo.path,
          remoteTrackingBase.branch,
          localGitExecOptions
        ))
      const hasLocalBaseRef =
        hasRemoteTrackingBaseRef || hasNamedLocalBaseRef || hasFallbackLocalBaseRef
      if (!hasRemoteTrackingBaseRef && hasLocalBaseRef) {
        // Why: use the usable local branch when offline refresh cannot create its tracking ref.
        if (hasFallbackLocalBaseRef) {
          baseBranch = remoteTrackingBase.branch
        }
        baseFallback = {
          requestedRef: remoteTrackingBase.base,
          localRef: baseBranch
        }
        remoteTrackingBase = null
      } else {
        emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
        remoteTrackingRefresh = {
          base: remoteTrackingBase,
          hadLocalBaseRef: hasRemoteTrackingBaseRef,
          promise: runtime.getOrStartRemoteTrackingBaseRefresh(repo.path, remoteTrackingBase, {
            ...localWorktreeGitOptions,
            timeout: remainingRefreshMs()
          })
        }
      }
    } else if (
      !(await hasLocalWorktreeBaseRefWithOptions(repo.path, baseBranch, localWorktreeGitOptions))
    ) {
      // Why: non-remote-prefix bases (plain main/master/local) keep the legacy best-effort fetch; verified PR SHA bases already have the object.
      legacyFetchPromise = runtime
        .fetchRemoteWithCache(repo.path, 'origin', {
          ...localWorktreeGitOptions,
          timeout: remainingRefreshMs()
        })
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  } else {
    if (
      !(await hasLocalWorktreeBaseRefWithOptions(repo.path, baseBranch, localWorktreeGitOptions))
    ) {
      legacyFetchPromise = gitExecFileAsync(['fetch', 'origin'], {
        ...localGitExecOptions,
        timeout: remainingRefreshMs()
      })
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  }
  const workspaceRoot = computeWorkspaceRoot(repo.path, worktreePathSettings)

  // Why: this validation doesn't depend on remote refs, so it can overlap a required remote-tracking base refresh.
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
        // Why: Set-based compare so directory order doesn't affect attribution — matches renderer's sparseDirectoriesMatch.
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

  const branchConflictSubject = args.branchNameOverride ? 'branch name' : 'worktree name'
  let resolved = false
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let lastExistingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
  let lastExistingReviewNumber: number | null = null
  // Why: a create-from-review branch override may already exist locally; suffix both branch and path instead of blocking the user.
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
      // Why: suffix retries may need a new path, but an existing-branch checkout must keep the user-selected branch, not a sibling.
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

    // Why: gh pr list is a ~1–3s network call; only probe PR conflicts after a branch collision (suffix > 1) so the common no-collision path skips it.
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
    // Why: every suffix collided; reject with a specific reason so the user sees why create failed instead of a generic error or hung spinner.
    if (lastExistingReviewNumber !== null) {
      throw new Error(
        `Branch "${branchName}" already has PR #${lastExistingReviewNumber}. Pick a different ${branchConflictSubject}.`
      )
    }
    if (lastBranchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different ${branchConflictSubject}.`
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
      if (!result.ok && !remoteTrackingRefresh.hadLocalBaseRef) {
        remainingRefreshMs()
        // Why: only block create when the refresh failed AND there's no local base ref; an existing (possibly stale) ref keeps worktree add viable.
        throw new Error(
          `Could not refresh base ref "${baseBranch}" from "${remoteTrackingRefresh.base.remote}". Check your network and try again.`
        )
      }
      if (
        !remoteTrackingRefresh.hadLocalBaseRef &&
        !(await runtime?.hasRemoteTrackingRef(repo.path, remoteTrackingRefresh.base, {
          ...localWorktreeGitOptions,
          timeout: remainingRefreshMs()
        }))
      ) {
        remainingRefreshMs()
        throw new Error(`Base ref "${baseBranch}" was not found after fetching.`)
      }
      remainingRefreshMs()
    })
  }

  if (legacyFetchPromise) {
    await timing.time('refresh_base_ref', async () => {
      await legacyFetchPromise
      remainingRefreshMs()
    })
  }
  emitCreateWorktreeProgress(mainWindow, 'creating', args.creationId)
  addRefreshTimeout = addRefreshTimeoutMs()

  let preparedPushTarget: GitPushTarget | undefined
  const releasePushTargetPreparation = args.pushTarget
    ? await acquireWorktreePushTargetPreparationLease(repo.path, args.pushTarget, {
        remainingTimeoutMs: remainingAddCheckoutMs
      })
    : undefined
  if (args.pushTarget) {
    // Why: validate/fetch the contributor remote before create so a failure doesn't leave a half-created worktree with conflicts on retry.
    try {
      preparedPushTarget = await prepareWorktreePushTarget(
        repo.path,
        args.pushTarget,
        store,
        repo.id,
        localWorktreeGitOptions,
        remainingAddCheckoutMs
      )
    } catch (error) {
      releasePushTargetPreparation?.()
      throw error
    }
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
  let addResult: AddWorktreeResult
  try {
    addResult =
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
  } catch (error) {
    await cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      `${repo.id}::${worktreePath}`,
      preparedPushTarget,
      store,
      localWorktreeGitOptions
    )
    releasePushTargetPreparation?.()
    throw error
  }

  let gitWorktrees: GitWorktreeInfo[]
  let created: GitWorktreeInfo
  let configuredPushTarget: GitPushTarget | undefined
  try {
    const registrationDeadline = createWorktreeCreateStageDeadline(
      createTimeouts.registrationMs,
      `Worktree registration timed out after ${createTimeouts.registrationMs}ms.`
    )
    gitWorktrees = await timing.time('list_created_worktree', async () =>
      hasLocalWorktreeGitOptions
        ? listWorktreesStrict(repo.path, {
            ...localWorktreeGitOptions,
            timeout: registrationDeadline.remainingMs(),
            detectSparseCheckout: false
          })
        : listWorktreesStrict(repo.path, {
            timeout: registrationDeadline.remainingMs(),
            detectSparseCheckout: false
          })
    )
    // Why: Git may canonicalize a symlinked create path; its exact branch identifies the listed row.
    const reconciled = findCreatedWorktree(gitWorktrees, worktreePath, branchName)
    if (!reconciled) {
      throw new Error('Worktree created but not found in listing')
    }
    created = reconciled
    if (preparedPushTarget) {
      // Why: fork-PR review worktrees publish back to the PR author's branch; set upstream so Push/Sync use the contributor remote, not origin.
      configuredPushTarget = await configureCreatedWorktreePushTarget(
        created.path,
        branchName,
        preparedPushTarget,
        {
          ...localWorktreeGitOptions,
          timeout: registrationDeadline.remainingMs()
        }
      )
    }
  } catch (error) {
    try {
      await rollbackFailedWorktreeCreate(
        repo.path,
        worktreePath,
        branchName,
        checkoutExistingBranch,
        localWorktreeGitOptions
      )
    } catch (cleanupError) {
      console.warn(`[worktree-create] Failed to roll back "${worktreePath}"`, cleanupError)
      releasePushTargetPreparation?.()
      throw appendFailedWorktreeCreateCleanupMessage(error, worktreePath)
    }
    await cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      `${repo.id}::${worktreePath}`,
      preparedPushTarget,
      store,
      localWorktreeGitOptions
    )
    releasePushTargetPreparation?.()
    throw error
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  // Why: PR/MR worktrees start from a head ref/SHA but Source Control must compare against the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived IDs can be reused after external deletion; rotate instance identity so stale lineage can't attach to the new occupant.
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    // Stamp activity so the worktree sorts into its final position immediately, avoiding a re-sort race with scroll-to-reveal.
    lastActivityAt: now,
    // createdAt protects the new worktree from ambient PTY bumps for CREATE_GRACE_MS (see createRemoteWorktree above).
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
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
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = (() => {
    try {
      return timing.timeSync('persist_metadata', () => {
        const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
        return { worktree: mergeWorktree(repo.id, created, meta) }
      })
    } finally {
      releasePushTargetPreparation?.()
    }
  })()
  const workspaceLineage = recordWorkspaceLineageForCreatedWorktree(store, args, worktree, now)
  // Why: reuse the roots creation already paid for via `git worktree list` so later IPC doesn't lazily rescan and trip macOS privacy prompts.
  registerWorktreeRootsForRepo(store, repo.id, [
    repo.path,
    ...gitWorktrees.map((worktree) => worktree.path)
  ])
  const materializationDeadlineAt = Date.now() + createTimeouts.materializationMs
  let materializationTimedOut = false
  const materializationOptions = {
    deadlineAt: materializationDeadlineAt,
    onDeadlineExceeded: () => {
      materializationTimedOut = true
    }
  }

  // Why: link user-configured shared paths (e.g. `node_modules`, `.env`) before setup runs so setup scripts see them in place.
  const symlinkPaths = repo.symlinkPaths ?? []
  if (symlinkPaths.length > 0) {
    await timing.time('create_symlinks', async () => {
      await createWorktreeLinkedPaths(repo.path, created.path, symlinkPaths, materializationOptions)
    })
  }

  // Why: project-level `orca.yaml` shared directories add to (never replace) the per-user
  // setting, so a repo's shared dirs reach every teammate (issue #10451).
  const sharedDirectories =
    Date.now() >= materializationDeadlineAt
      ? ((materializationTimedOut = true), [])
      : await timing.time('resolve_shared_directories', () =>
          resolveWorktreeSharedDirectories(repo.path, localWorktreeGitOptions)
        )
  if (sharedDirectories.length > 0) {
    await timing.time('create_shared_directories', async () => {
      await createWorktreeSharedPaths(
        repo.path,
        created.path,
        sharedDirectories,
        materializationOptions
      )
    })
  }

  // Why: project-level `.worktreeinclude` travels with the repo (issue #7549); copy semantics
  // (never symlink) so each worktree owns its files. Paths already linked above are skipped.
  const includePaths =
    Date.now() >= materializationDeadlineAt
      ? ((materializationTimedOut = true), [])
      : await timing.time('resolve_worktreeinclude', () =>
          resolveWorktreeIncludePaths(repo.path, localWorktreeGitOptions)
        )
  let includeCopyWarning: string | undefined
  if (includePaths.length > 0) {
    await timing.time('copy_worktreeinclude', async () => {
      const skippedIncludePaths = await createWorktreeCopiedPaths(
        repo.path,
        created.path,
        includePaths,
        materializationOptions
      )
      includeCopyWarning = formatWorktreeIncludeCopyWarning(skippedIncludePaths)
      if (includeCopyWarning) {
        console.warn(`[worktree-include] ${includeCopyWarning}`)
      }
    })
  }
  if (materializationTimedOut) {
    includeCopyWarning = appendWorktreeCreateWarning(
      includeCopyWarning,
      `Workspace materialization stopped after ${createTimeouts.materializationMs}ms; the worktree was kept and remaining shared paths can be added manually.`
    )
  }

  // Why: the worktree's base-branch `orca.yaml` is authoritative; we don't re-gate on content parity with the primary checkout since benign divergence silently disabled setup (#1280).
  let setup: CreateWorktreeResult['setup']
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  await timing.time('prepare_setup', async () => {
    const createdYamlHooks = loadHooks(worktreePath)
    const createdEffectiveHooks = getEffectiveHooksFromConfig(repo, createdYamlHooks)
    try {
      defaultTabs = getDefaultTabsLaunch(createdYamlHooks, repo, args.setupDecision)
    } catch (error) {
      // Why: default tab commands share setup's run policy; if the target branch adds commands without a renderer decision, create the tabs but don't run them.
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
        // Why: target branch may add setup hooks the renderer never collected a decision for; worktree exists, so skip setup rather than fail creation.
        console.warn(`[hooks] setup hook skipped for ${worktreePath}:`, error)
      }
    }
    if (setupScript && shouldLaunchSetup) {
      try {
        // Why: main only writes the runner script and must not execute setup itself, or we reintroduce the old hidden background-hook behavior.
        // Why: worktree already exists, so a runner-gen failure degrades to "created without setup launch" rather than failing creation.
        // Why: both trailing args are optional — the shell is undefined off Windows.
        setup = createSetupRunnerScript(
          repo,
          worktreePath,
          setupScript,
          localWorktreeGitOptionArgs[0],
          resolveSetupRunnerShell(settings)
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
    ...(baseFallback ? { baseFallback } : {}),
    ...(stagedStartup.warning
      ? { warning: appendWorktreeCreateWarning(includeCopyWarning, stagedStartup.warning) }
      : includeCopyWarning
        ? { warning: includeCopyWarning }
        : {}),
    timing: timing.finish()
  }
}
