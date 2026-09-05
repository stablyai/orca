/* eslint-disable max-lines */
// Why: worktree create helpers (local + remote) split out of worktrees.ts; the cohesive create flow runs this file just over the per-file line limit.

import { getRepoHostedReviewExecutionHostId } from '../source-control/hosted-review-execution-host'
import type { BrowserWindow } from 'electron'
import { posix, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { SetupAgentStartupPolicy } from '../../shared/orca-yaml-hook-types'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  WorktreeCreateBaseFallback
} from '../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  Worktree,
  WorktreeHeadIdentity
} from '../../shared/worktree/types'
import { getPRForBranch } from '../github/client'
import { listWorktrees, addWorktree, addSparseWorktree } from '../git/worktree'
import type { AddWorktreeOptions, AddWorktreeResult } from '../git/worktree'
import { consumePreparedWorktreeCreate } from '../worktree-create-preparation'
import {
  getBranchConflictKind,
  resolveDefaultBaseRefViaExec,
  resolveDefaultBaseRefWithLocalGit
} from '../git/repo'
import { getBranchConflictKindViaExec } from '../git/repo-branch-conflict'
import { resolveLocalGitUsername, getSshGitUsername } from '../git/git-username'
import { hasCommitObjectViaGitExec } from '../git/commit-object-ref'
import {
  hasLocalWorktreeBaseRef,
  probeWorktreeBaseRefPresence
} from '../git/worktree-base-ref-probe'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
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
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { getEffectiveHooks, loadHooks, parseOrcaYaml } from '../hooks'
import { buildPosixRunnerScript, buildWindowsRunnerScript } from '../setup-runner-script-text'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import { getSetupRunnerEnvVars } from '../setup-hook-env-vars'
import {
  getDefaultTabsLaunch,
  getEffectiveHooksFromConfig,
  shouldRunSetupForCreate
} from '../effective-hook-config'
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
import {
  sanitizeWorktreeName,
  resolveWorktreeCreateDisplayNameRequest,
  resolveWorktreeCreateDisplayNameMeta,
  computeValidatedBranchName,
  computeWorktreePath,
  computeRemoteWorktreePath,
  computeWorkspaceRoot,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath,
  mergeWorktree
} from './worktree-logic'
import { findCreatedWorktree, resolveCreatedWorktree } from './created-worktree-reconciliation'
import type { BranchPrefixSettings } from '../../shared/branch-prefix'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { sharesWorktreeLineageBoundary } from '../../shared/resolved-worktree-lineage'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  sameGitHubRemoteUrl,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'
import {
  reconcileOrphanedPrRemotes,
  reconcileOrphanedPrRemotesSsh
} from './worktree-push-target-reconciliation'
import {
  configureCreatedWorktreePushTargetWithExec,
  ensureUniqueRemoteName,
  findRemoteForUrl,
  prepareWorktreePushTargetWithExec,
  remoteAlreadyMatchesUrl,
  restoreUpstreamAfterMaterialize
} from './worktree-push-target-setup'
import {
  buildNarrowForkFetchRefspec,
  ensureRemoteTracksBranchNarrowly,
  forkRemoteTrackingRefExists
} from '../git/fork-remote-refspec'
import { migrateForkRemoteRefspecs } from './worktree-push-target-refspec-migration'
import { isENOENT } from './filesystem-path-containment'
import {
  registerCreatedWorktreeRoot,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'
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
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from '../project-runtime-git-options'
import {
  getBranchNameOverrideCandidate,
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName,
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS
} from '../worktree-create-candidates'
import {
  failedWorktreeCreationNeedsRetirement,
  getRetiredNameRegistryForRepo,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'
import { createRetiredNameLookup } from '../../shared/worktree/retired-name-registry'

const SSH_WORKTREE_CREATE_FETCH_FRESHNESS_MS = 30_000
const SSH_WORKTREE_CREATE_FETCH_CACHE_MAX = 512
// Why: bound the fallback `git fetch origin` so a Windows credential-manager GUI hang (STA-1292) can't wedge worktree creation forever.
const CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS = 60_000
// Why (#17828 CodeRabbit follow-up): the deferred materialize fetch runs off the main
// create path (terminal spawn, mid-session sync) with nothing else bounding it -- same
// STA-1292 hang risk as the create-time fallback above, so mirror its timeout.
const DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS = 60_000
const sshWorktreeCreateFetchInflight = new Map<string, Promise<void>>()
const sshWorktreeCreateFetchCompletedAt = new Map<string, number>()
const sshWorktreeCreateFetchQueueTail = new Map<string, Promise<void>>()
// Why (#17828 CodeRabbit follow-up): a terminal spawn and an explicit sync action can
// both call materialize for the same worktree remote at once; without single-flighting,
// the loser's `remote add` races the winner's fetch and can strand a duplicate remote.
const worktreePushTargetMaterializeInflight = new Map<string, Promise<GitPushTarget>>()
const sshWorktreePushTargetMaterializeInflight = new WeakMap<
  SshGitProvider,
  Map<string, Promise<GitPushTarget>>
>()

function worktreePushTargetMaterializeKey(repoPath: string, remoteName: string): string {
  return `${repoPath}::${remoteName}`
}

function getSshWorktreePushTargetMaterializeInflight(
  provider: SshGitProvider
): Map<string, Promise<GitPushTarget>> {
  let inflight = sshWorktreePushTargetMaterializeInflight.get(provider)
  if (!inflight) {
    inflight = new Map()
    sshWorktreePushTargetMaterializeInflight.set(provider, inflight)
  }
  return inflight
}
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
      // undefined = nothing to refresh (no local branch yet), so the caller reports no status at all.
      result: LocalBaseRefRefreshResult | undefined
    }

function appendWorktreeCreateWarning(current: string | undefined, next: string): string {
  return current ? `${current} Also ${next[0]?.toLowerCase() ?? ''}${next.slice(1)}` : next
}

function getSetupRunnerCommandPlatformForLaunch(
  setup: CreateWorktreeResult['setup'],
  fallbackPlatform: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallbackPlatform)
}

/** Why not throw on a missing parent: nesting is optional decoration, and the pick can go stale
 *  between the composer and the create. A malformed or self-referential key is a bad request and
 *  still fails; a parent that simply disappeared degrades to an unattached workspace, matching the
 *  runtime path and `recordWorkspaceLineageForCreatedWorktree`. */
export function assertAttachableParentWorkspace(
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
    console.warn(`[worktree-create] parent folder workspace not found: ${parentWorkspace}`)
    return
  }
  if (parentScope.type === 'worktree' && !store.getWorktreeMeta(parentScope.worktreeId)) {
    console.warn(`[worktree-create] parent worktree workspace not found: ${parentWorkspace}`)
  }
}

type CreatedWorktreeLineageRecords = {
  lineage: CreateWorktreeResult['lineage']
  workspaceLineage: CreateWorktreeResult['workspaceLineage']
}

const NO_CREATED_WORKTREE_LINEAGE: CreatedWorktreeLineageRecords = {
  lineage: null,
  workspaceLineage: null
}

/** Mirrors the projection's edge rule so we never persist a row the sidebar would silently drop.
 *  WorktreeMeta has no repoId, so the parent's comes from its `<repoId>::<path>` id. */
function createdWorktreeSharesParentLineageBoundary(
  worktree: Worktree,
  parentWorktreeId: string,
  parentMeta: WorktreeMeta
): boolean {
  return sharesWorktreeLineageBoundary(worktree, {
    repoId: getRepoIdFromWorktreeId(parentWorktreeId),
    hostId: parentMeta.hostId,
    projectId: parentMeta.projectId
  })
}

export function recordWorkspaceLineageForCreatedWorktree(
  store: Store,
  args: CreateWorktreeArgs,
  worktree: Worktree,
  createdAt: number
): CreatedWorktreeLineageRecords {
  if (!args.parentWorkspace || !worktree.instanceId) {
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const childWorkspaceKey = worktreeWorkspaceKey(worktree.id)
  if (args.parentWorkspace === childWorkspaceKey) {
    console.warn(`[worktree-create] refusing to attach ${worktree.id} to itself`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const parentScope = parseWorkspaceKey(args.parentWorkspace)
  if (!parentScope) {
    console.warn(`[worktree-create] ignoring invalid parent workspace ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  if (parentScope.type === 'folder' && !store.getFolderWorkspace(parentScope.folderWorkspaceId)) {
    console.warn(`[worktree-create] parent folder workspace disappeared: ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const parentWorktreeMeta =
    parentScope.type === 'worktree' ? store.getWorktreeMeta(parentScope.worktreeId) : null
  if (parentScope.type === 'worktree' && !parentWorktreeMeta) {
    console.warn(`[worktree-create] parent worktree workspace disappeared: ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }

  // Why: only a worktree parent produces sidebar nesting; a folder parent has no WorktreeLineage row.
  let lineage: CreateWorktreeResult['lineage'] = null
  let parentOutsideLineageBoundary = false
  if (parentScope.type === 'worktree' && parentWorktreeMeta) {
    if (!parentWorktreeMeta.instanceId) {
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} has no instance identity; skipping lineage`
      )
    } else if (
      !createdWorktreeSharesParentLineageBoundary(
        worktree,
        parentScope.worktreeId,
        parentWorktreeMeta
      )
    ) {
      parentOutsideLineageBoundary = true
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} is outside ${worktree.id}'s repo/host/project boundary; skipping lineage`
      )
    } else {
      lineage = store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: parentScope.worktreeId,
        parentWorktreeInstanceId: parentWorktreeMeta.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt
      })
    }
  }

  // Why: persisting a workspace row for an out-of-boundary worktree parent poisons the whole host —
  // `filterLineageForHost` returns null for any owned row whose child and parent hosts differ, so
  // every nesting on that host stops hydrating, and the row survives restarts.
  if (parentOutsideLineageBoundary) {
    return NO_CREATED_WORKTREE_LINEAGE
  }

  const workspaceLineage = store.setWorkspaceLineage({
    childWorkspaceKey,
    childInstanceId: worktree.instanceId,
    parentWorkspaceKey: args.parentWorkspace,
    parentInstanceId: parentWorktreeMeta?.instanceId ?? null,
    origin: 'manual',
    capture: {
      source: parentScope.type === 'worktree' ? 'manual-action' : 'active-workspace',
      confidence: 'explicit'
    },
    createdAt
  })
  return { lineage, workspaceLineage }
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
    // Why: SSH creation has no OrcaRuntimeService to share; still reuse recent fetches for repeated creates on the same target.
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
    () =>
      // Why: the exact-base refresh gates create; unrelated repo housekeeping must not extend it.
      provider.fetchRemoteTrackingRef(repo.path, base.remote, base.branch, base.ref, {
        skipAutoMaintenance: true
      })
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
    // Best-effort cleanup; keep the sparse setup error as the actionable failure.
  }
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

async function hasRemoteWorktreeBaseRef(
  provider: SshGitProvider,
  repoPath: string,
  baseRef: string
): Promise<boolean> {
  const refExists = (qualifiedRef: string) => hasCommitRefSsh(provider, repoPath, qualifiedRef)
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasRemoteCommitObject(provider, repoPath, baseRef)
}

// Why: hasRemoteCommitObject resolves only SHAs, not symbolic refs; resolve any qualified ref (remote-tracking or local head) directly.
async function hasCommitRefSsh(
  provider: SshGitProvider,
  repoPath: string,
  ref: string
): Promise<boolean> {
  try {
    const { stdout } = await provider.exec(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      repoPath
    )
    return stdout.trim().length > 0
  } catch {
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

type SshGitExecutor = Pick<SshGitProvider, 'exec'>

export function getSshBranchConflictKind(
  provider: SshGitExecutor,
  repoPath: string,
  branchName: string,
  allowedBaseRef: string
): Promise<'local' | 'remote' | null> {
  return getBranchConflictKindViaExec(
    (argv, commandOptions) =>
      commandOptions?.timeoutMs === undefined
        ? provider.exec(argv, repoPath)
        : provider.exec(argv, repoPath, { timeoutMs: commandOptions.timeoutMs }),
    branchName,
    allowedBaseRef
  )
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
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>,
  branchName: string,
  args: SelectedReviewBranchInput
): Promise<{ matchesSelected: boolean; number: number } | null> {
  const selectedReview = getSelectedReviewBranch(args)
  if (!selectedReview) {
    return null
  }
  const review = await getHostedReviewForBranch({
    repoPath: repo.path,
    executionHostId: getRepoHostedReviewExecutionHostId(repo),
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
  const prepared = await prepareWorktreePushTargetWithExec(
    // Why: this is only ever reached via the deferred materialize path (#17828) -- bound
    // just the network fetch so it can't hang indefinitely (see the timeout constant's
    // comment). The other calls this makes (`remote`, `remote add`, `config`) are local-only
    // and must stay untimed, matching every other local git call in this file.
    (args, cwd) =>
      gitExecFileAsync(args, {
        cwd,
        ...gitOptions,
        ...(args[0] === 'fetch' ? { timeout: DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS } : {})
      }),
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
  // Why: opportunistically narrow any other fork remote in this repo still on the old
  // wide refspec (pre-#17828 mint, or reused before this fix). Rate-limited and
  // fire-and-forget so a large leaked-remote backlog never slows down this create.
  if (store && repoId) {
    void migrateForkRemoteRefspecs(repoPath, repoId, store, gitOptions)
  }
  return prepared
}

// Why: on-demand twin of `prepareWorktreePushTarget` for push/pull/fetch/
// fast-forward (#17828) -- a deferred fork remote is materialized the first
// time it's needed. The cheap named-remote probe keeps every push after the
// first one down to a handful of extra subprocesses (probe, refspec-widen,
// upstream-restore) instead of repeating the O(remotes) scan
// `prepareWorktreePushTargetWithExec` does when it must add.
export async function materializeWorktreePushTargetRemote(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string,
  gitOptions: { wslDistro?: string } = {},
  worktreeId?: string
): Promise<GitPushTarget> {
  if (!target.remoteUrl || target.remoteCreated) {
    return target
  }
  const execGit: GitRemoteExec = (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions })
  if (await remoteAlreadyMatchesUrl(execGit, repoPath, target.remoteName, target.remoteUrl)) {
    return runForkRemoteAdoption(repoPath, target, () =>
      adoptExistingForkRemoteForBranch(
        execGit,
        repoPath,
        target,
        gitOptions,
        store,
        repoId,
        worktreeId
      )
    )
  }
  const key = worktreePushTargetMaterializeKey(repoPath, target.remoteName)
  const existing = worktreePushTargetMaterializeInflight.get(key)
  if (existing) {
    // Why: the single flight is keyed on the *remote*, but everything after the remote add is
    // per-branch. A joiner waiting on a sibling worktree's mint must not take that sibling's
    // target -- it would inherit the sibling's branch and silently skip its own refspec widen,
    // tracking-ref fetch, and upstream link. Wait for the remote, then do its own.
    //
    // Why not swallow the rejection: both mint rollbacks remove the remote, so adopting after a
    // failed mint would write `remote.<name>.fetch` with no URL -- a config-only ghost that
    // breaks `git fetch --all`, forces every later mint to a `-2` name, and survives
    // `git remote remove`. Propagate instead; the map is already cleared, so a retry re-mints.
    await existing
    return runForkRemoteAdoption(repoPath, target, () =>
      adoptExistingForkRemoteForBranch(
        execGit,
        repoPath,
        target,
        gitOptions,
        store,
        repoId,
        worktreeId
      )
    )
  }
  const promise = prepareWorktreePushTarget(repoPath, target, store, repoId, gitOptions)
    .then((prepared) => restoreUpstreamAfterMaterialize(execGit, repoPath, prepared))
    .then((prepared) => {
      persistMaterializedPushTargetIfCreated(store, worktreeId, prepared)
      return prepared
    })
    .finally(() => {
      if (worktreePushTargetMaterializeInflight.get(key) === promise) {
        worktreePushTargetMaterializeInflight.delete(key)
      }
    })
  worktreePushTargetMaterializeInflight.set(key, promise)
  return promise
}

// Why: the remote already exists -- minted by an earlier call, by create, or by a sibling
// worktree. Everything left is per-branch, and it must run for *this* target: the refspec
// widen, the tracking-ref fetch, and the upstream link. Previously these only ran inside
// prepareWorktreePushTarget, unreachable once the remote was there.
async function adoptExistingForkRemoteForBranch(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget,
  gitOptions: { wslDistro?: string },
  store: WorktreePushTargetStore | undefined,
  repoId: string | undefined,
  worktreeId: string | undefined
): Promise<GitPushTarget> {
  await ensureRemoteTracksBranchNarrowly(execGit, repoPath, target.remoteName, target.branchName)
  // Why: widening only rewrites config -- it never imports anything. For a sibling worktree's
  // first materialize of a *new* branch on an already-existing remote, the branch's tracking
  // ref doesn't exist yet, and `--set-upstream-to` below hard-fails with "the requested
  // upstream branch does not exist" (verified against real git). Skip the fetch when the ref
  // is already there so a repeat push/pull materialize stays a local-only probe.
  if (
    !(await forkRemoteTrackingRefExists(execGit, repoPath, target.remoteName, target.branchName))
  ) {
    // Why: a network fetch, unlike the local-only probes above -- bound it the same as the
    // full-mint path's fetch so it can't hang indefinitely.
    await gitExecFileAsync(
      [
        'fetch',
        target.remoteName,
        buildNarrowForkFetchRefspec(target.remoteName, target.branchName)
      ],
      { cwd: repoPath, ...gitOptions, timeout: DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS }
    )
  }
  const restored = await restoreUpstreamAfterMaterialize(execGit, repoPath, target)
  // Why: a remote another worktree minted is still Orca-owned. Without stamping ownership on
  // the adopting worktree too, removing the minter leaves the survivor's metadata unowned and
  // #17842's sweep -- which gates solely on `remoteCreated` -- can never reclaim the remote.
  // Why derive: no caller supplies both -- IPC handlers pass a store with no repo id, runtime
  // commands pass a repo id with no store -- so requiring both made this branch unreachable.
  const ownerRepoId = repoId ?? (worktreeId ? getRepoIdFromWorktreeId(worktreeId) : undefined)
  const owned =
    store !== undefined &&
    ownerRepoId !== undefined &&
    isPushTargetRemoteCreatedByKnownWorktree(store, restored, ownerRepoId)
  const adopted = owned ? { ...restored, remoteCreated: true } : restored
  persistMaterializedPushTargetIfCreated(store, worktreeId, adopted)
  return adopted
}

// Why: the mint single flight only covers `remote add`. Every adopter afterwards writes
// `remote.<name>.fetch` and `.tagOpt`, and concurrent `git config --add` has no lock retry --
// measured 135/160 failures at 8-way concurrency, plus duplicate refspecs when two adopts add
// the same value. Chain adopts per remote so they serialize instead of fanning out.
const forkRemoteAdoptionQueue = new Map<string, Promise<unknown>>()

function runForkRemoteAdoption<T>(
  repoPath: string,
  target: GitPushTarget,
  run: () => Promise<T>
): Promise<T> {
  const key = worktreePushTargetMaterializeKey(repoPath, target.remoteName)
  const previous = forkRemoteAdoptionQueue.get(key)
  const next = previous ? previous.then(run, run) : run()
  const settled = next.then(
    () => undefined,
    () => undefined
  )
  forkRemoteAdoptionQueue.set(key, settled)
  void settled.finally(() => {
    if (forkRemoteAdoptionQueue.get(key) === settled) {
      forkRemoteAdoptionQueue.delete(key)
    }
  })
  return next
}

// Why (review follow-up): on-demand materialization never went through the create-time
// `setWorktreeMeta` write, so the store's `pushTarget.remoteCreated` flag stayed stale
// forever for a lazily-minted remote -- invisible to #17842's orphan sweep
// (`shouldReclaimPrRemote` gates solely on that flag) and to any SSH host whose relay
// predates `markRemoteOrcaCreated` (no git-config marker either). `setWorktreeMeta` is
// optional on `WorktreePushTargetStore` so narrow test/reconciliation stores keep compiling.
function persistMaterializedPushTargetIfCreated(
  store: WorktreePushTargetStore | undefined,
  worktreeId: string | undefined,
  target: GitPushTarget
): void {
  if (!target.remoteCreated || !worktreeId || !store?.setWorktreeMeta) {
    return
  }
  store.setWorktreeMeta(worktreeId, { pushTarget: target })
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
  // Why: also catches remotes this specific removal couldn't reclaim (legacy metadata,
  // a preserved branch since deleted, a worktree removed outside Orca) -- see
  // worktree-push-target-reconciliation.ts. Rate-limited internally; safe to call every removal.
  // Not awaited: a repo with a large backlog (the scenario this exists for) can have dozens of
  // candidate remotes, each probed with a couple of git subprocesses -- that must never add
  // latency to the worktree-removal call the user is waiting on. It catches its own errors.
  void reconcileOrphanedPrRemotes(
    repoPath,
    getRepoIdFromWorktreeId(removedWorktreeId),
    store,
    gitOptions
  )
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

export async function prepareWorktreePushTargetSsh(
  provider: SshGitProvider,
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string
): Promise<GitPushTarget> {
  assertGitPushTargetShape(target)
  const execGit: GitRemoteExec = (args, cwd) => provider.exec(args, cwd)
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  await provider.exec(['check-ref-format', '--branch', target.branchName], repoPath)
  let remoteName = target.remoteName
  let remoteCreated = false
  // Why: ownership above is inherited from sibling worktrees, so it can be true
  // for a remote this call did not create. Only rollback needs that distinction.
  let remoteAddedHere = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(execGit, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: a reused Orca-created fork remote must inherit ownership so deleting the final user can remove it.
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
      remoteName = await ensureUniqueRemoteName(execGit, repoPath, target.remoteName)
      try {
        await provider.exec(['remote', 'add', remoteName, target.remoteUrl], repoPath)
      } catch (error) {
        // Why: relays predating fork-remote support reject this exec by policy; name the fix instead of surfacing their rule.
        if (error instanceof Error && error.message.includes('Destructive git remote operations')) {
          throw new Error(
            'This SSH host is running an older Orca relay that cannot add a fork remote for a PR workspace. Reconnect to deploy the latest relay, then try again.'
          )
        }
        throw error
      }
      remoteAddedHere = true
      try {
        // Why: repo-local provenance mirroring the local path (worktree-push-target-setup.ts).
        // A narrow RPC, not provider.exec: the relay's generic git.exec blocks all config writes.
        await provider.markRemoteOrcaCreated(repoPath, remoteName)
      } catch (error) {
        // Why: a remote with no provenance marker is unreclaimable -- cleanup only
        // runs off that marker, so a failure here must undo the add.
        await provider.exec(['remote', 'remove', remoteName], repoPath).catch(() => {})
        throw error
      }
      remoteCreated = true
    }
  }
  try {
    await provider.fetchRemoteTrackingRef(
      repoPath,
      remoteName,
      target.branchName,
      `refs/remotes/${remoteName}/${target.branchName}`
    )
  } catch (error) {
    // Why: mirrors the local path — a fetch failure aborts the create, so the
    // remote we just added on the host would be orphaned with no owner to clean it.
    // A reused remote belongs to a live sibling worktree; removing it breaks that one.
    if (remoteAddedHere) {
      await provider.exec(['remote', 'remove', remoteName], repoPath).catch(() => {})
    }
    throw error
  }
  return { ...sanitizedTarget, remoteName, ...(remoteCreated ? { remoteCreated: true } : {}) }
}

// SSH twin of `adoptExistingForkRemoteForBranch`. Refspec widening is intentionally absent --
// SSH's bare `remote add` (no `-t`/`--no-tags`) is a pre-existing, documented gap -- but the
// tracking ref must still exist before `--set-upstream-to` can succeed, and the upstream link
// must be made against *this* target's branch rather than a minting sibling's.
async function adoptExistingSshForkRemoteForBranch(
  provider: SshGitProvider,
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget,
  store: WorktreePushTargetStore | undefined,
  worktreeId: string | undefined
): Promise<GitPushTarget> {
  if (
    !(await forkRemoteTrackingRefExists(execGit, repoPath, target.remoteName, target.branchName))
  ) {
    await provider.fetchRemoteTrackingRef(
      repoPath,
      target.remoteName,
      target.branchName,
      `refs/remotes/${target.remoteName}/${target.branchName}`
    )
  }
  const restored = await restoreUpstreamAfterMaterialize(execGit, repoPath, target)
  const ownerRepoId = worktreeId ? getRepoIdFromWorktreeId(worktreeId) : undefined
  const owned =
    store !== undefined &&
    ownerRepoId !== undefined &&
    isPushTargetRemoteCreatedByKnownWorktree(store, restored, ownerRepoId)
  const adopted = owned ? { ...restored, remoteCreated: true } : restored
  persistMaterializedPushTargetIfCreated(store, worktreeId, adopted)
  return adopted
}

// SSH twin of `materializeWorktreePushTargetRemote` -- the relay has no store
// access and trusts `pushTarget.remoteName` already exists, so a deferred fork
// remote must be materialized client-side before dispatching push/pull/fetch/
// fast-forward over the mux (#17828).
export async function materializeWorktreePushTargetRemoteSsh(
  provider: SshGitProvider,
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string,
  worktreeId?: string
): Promise<GitPushTarget> {
  if (!target.remoteUrl || target.remoteCreated) {
    return target
  }
  const execGit: GitRemoteExec = (args, cwd) => provider.exec(args, cwd)
  if (await remoteAlreadyMatchesUrl(execGit, repoPath, target.remoteName, target.remoteUrl)) {
    // Why (review follow-up): mirrors the local short-circuit's upstream restore. Refspec
    // widening is intentionally NOT mirrored here -- SSH's bare `remote add` (no `-t`/
    // `--no-tags`, see prepareWorktreePushTargetSsh) is a pre-existing, documented gap this
    // fix does not touch.
    //
    // The tracking ref itself, though, must still exist before `--set-upstream-to` below
    // can succeed -- a reused remote's wide default refspec covers a future bare fetch,
    // but imports nothing on its own. Fetch just this branch (a one-off refspec argument,
    // not a config write) when it isn't already there; skip it otherwise so a repeat
    // push/pull materialize stays a local-only probe with no relay round-trip.
    return runForkRemoteAdoption(repoPath, target, () =>
      adoptExistingSshForkRemoteForBranch(provider, execGit, repoPath, target, store, worktreeId)
    )
  }
  const inflight = getSshWorktreePushTargetMaterializeInflight(provider)
  const key = worktreePushTargetMaterializeKey(repoPath, target.remoteName)
  const existing = inflight.get(key)
  if (existing) {
    // Why: same per-branch reasoning as the local twin -- a joiner must not inherit the
    // minter's branch. Rejection propagates rather than adopting a remote the rollback removed.
    await existing
    return runForkRemoteAdoption(repoPath, target, () =>
      adoptExistingSshForkRemoteForBranch(provider, execGit, repoPath, target, store, worktreeId)
    )
  }
  const promise = prepareWorktreePushTargetSsh(provider, repoPath, target, store, repoId)
    .then((prepared) => restoreUpstreamAfterMaterialize(execGit, repoPath, prepared))
    .then((prepared) => {
      persistMaterializedPushTargetIfCreated(store, worktreeId, prepared)
      return prepared
    })
    .finally(() => {
      if (inflight.get(key) === promise) {
        inflight.delete(key)
      }
    })
  inflight.set(key, promise)
  return promise
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
  // Why: SSH counterpart of the sweep above -- the execution host owns these remotes.
  // Not awaited for the same reason as the local path: never add sweep latency to removal.
  void reconcileOrphanedPrRemotesSsh(
    provider,
    repoPath,
    getRepoIdFromWorktreeId(removedWorktreeId),
    store
  )
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
  fsProvider: IFilesystemProvider,
  projectStartupPolicy?: SetupAgentStartupPolicy
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
    ...(shouldWaitForSetupBeforeAgentStartup(
      repo.hookSettings?.setupAgentStartupPolicy,
      projectStartupPolicy
    )
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
        if (await hasCommitRefSsh(provider, repo.path, remoteTrackingBase.ref)) {
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
      (await hasCommitRefSsh(provider, repo.path, basePlan.remoteTrackingBase.ref)) ||
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
  remoteTrackingBase: RemoteTrackingBase
): Promise<LocalBaseRefRefreshResult | undefined> {
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
  remoteTrackingBase: RemoteTrackingBase,
  shouldInspectOwner: (behind: number) => boolean = () => true
): Promise<RemoteLocalBaseRefRefreshability> {
  const resultBase = {
    baseRef: remoteTrackingBase.base,
    localBranch: remoteTrackingBase.branch
  }
  const fullRef = `refs/heads/${remoteTrackingBase.branch}`

  let behind = 0
  try {
    // Why: SSH generic git.exec is allowlisted — merge-base and log are permitted read-only probes; rev-list is intentionally not exposed.
    await provider.exec(['merge-base', '--is-ancestor', fullRef, remoteTrackingBase.ref], repoPath)
    const { stdout } = await provider.exec(
      ['log', '--format=%H', `${fullRef}..${remoteTrackingBase.ref}`],
      repoPath
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
    // Why (#15331): the probes above also fail when refs/heads/<branch> is simply absent; the relay's
    // `worktree add -b` is about to create it, so there is nothing stale to warn about. Only a proven
    // absence suppresses: a dropped relay connection is not evidence the branch is missing.
    const presence = await probeWorktreeBaseRefPresence(
      (args) => provider.exec(args, repoPath),
      fullRef
    )
    if (presence === 'absent') {
      return { refreshable: false, result: undefined }
    }
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

    // Why: not checked out anywhere, so a bare-ref fast-forward is safe; omitting ownerWorktreePath tells the relay to update-ref, not reset --hard.
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
    remoteTrackingBase,
    (behind) => behind > 0
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
  const displayNameRequest = resolveWorktreeCreateDisplayNameRequest(
    args.displayName,
    args.displayNameKind,
    args.name,
    args.cliProvenance?.kind === 'created-by-cli',
    args.nameWasGenerated === true
  )
  const requestedDisplayName = displayNameRequest.value

  // Why: base resolution probes refs via generic git.exec; register the repo root first so relays don't report a valid base as stale.
  await registerRequiredSshWorktreeCreateRoots(repo.connectionId!, [repo.path])

  // Why: explicit branches and non-username prefix modes never consume this; skipping the remote probe preserves the exact branch name.
  const branchConflictSubject = args.branchNameOverride ? 'branch name' : 'worktree name'
  // Why: don't fall back to hardcoded 'origin/main'; it may not exist (master/develop) and yields an opaque git error, so fail clearly and let the UI prompt.
  // Username and base-plan probes are independent read-only work; overlap them so
  // SSH latency is paid once before the conflict loop.
  const [username, basePlan] = await Promise.all([
    !args.branchNameOverride && settings.branchPrefix === 'git-username'
      ? getSshGitUsername(provider, repo.path)
      : Promise.resolve(''),
    getOrStartRemoteWorktreeCreateBasePlan(provider, repo, args.baseBranch)
  ])
  if (!basePlan) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }
  let { baseBranch } = basePlan
  let { remoteTrackingBase } = basePlan
  let baseFallback: WorktreeCreateBaseFallback | undefined

  if (remoteTrackingBase) {
    const [hasRemoteTrackingBaseRef, hasNamedLocalBaseRef] = await Promise.all([
      hasCommitRefSsh(provider, repo.path, remoteTrackingBase.ref),
      hasRemoteWorktreeBaseRef(provider, repo.path, baseBranch)
    ])
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
  const shouldRetireGeneratedName =
    args.nameWasGenerated === true && isGeneratedWorktreeCreateName(sanitizedName)
  const retiredNameRegistry = shouldRetireGeneratedName
    ? await getRetiredNameRegistryForRepo(store, repo, store.getRepos(), settings)
    : null
  const isRetiredName = retiredNameRegistry ? createRetiredNameLookup(retiredNameRegistry) : null
  // Why: duplicate PR/MR checkouts still need a workspace; suffix branch/path while preserving review metadata and push target.
  for (let suffix = 1, attempts = 0; attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = shouldRetireGeneratedName
      ? getGeneratedWorktreeCreateCandidate(
          sanitizedName,
          suffix,
          retiredNameRegistry?.exhaustedTiers
        )
      : getWorktreeCreateCandidate(sanitizedName, suffix)
    effectiveRequestedName = shouldRetireGeneratedName
      ? effectiveSanitizedName
      : args.name.trim()
        ? getWorktreeCreateCandidate(args.name, suffix)
        : effectiveSanitizedName
    if (isRetiredName?.(effectiveSanitizedName)) {
      continue
    }
    attempts += 1
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

  assertAttachableParentWorkspace(
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

  if (remoteTrackingBase) {
    try {
      await refreshRemoteTrackingBaseForWorktreeCreate(provider, repo, remoteTrackingBase)
    } catch {
      // Why: a refresh failure shouldn't block create if a usable (stale) local base ref exists; probe after registerRoot and hard-fail only when none does.
      if (!(await hasCommitRefSsh(provider, repo.path, remoteTrackingBase.ref))) {
        throw new Error(
          `Could not refresh base ref "${baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
        )
      }
    }
  } else if (!(await hasRemoteWorktreeBaseRef(provider, repo.path, baseBranch))) {
    // Why: non-remote-tracking bases keep the legacy best-effort fetch; verified PR/MR SHA bases already have the object, so a broad fetch is wasted.
    try {
      await fetchRemoteForWorktreeCreate(provider, repo, 'origin')
    } catch {
      /* best-effort */
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

  // Why: defer the remote add + fetch to first push/pull/fetch/fast-forward
  // (#17828) instead of paying it at create time for a read-only review.
  const preparedPushTarget: GitPushTarget | undefined = args.pushTarget

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
      // Why: only OLD relays (pre-allowlist-removal) throw these; surface an upgrade message. Remove after version floor moves (docs/relay-fs-allowlist-removal.md).
      throw new Error(
        `Older relay reported an authorization error; please reconnect to deploy the latest relay. (${err.message})`
      )
    }
    throw err
  }
  if (sparseDirectories.length > 0) {
    try {
      // Why: SSH providers expose generic git exec, so remote sparse mirrors local addSparseWorktree without a new relay method.
      await provider.exec(['sparse-checkout', 'init', '--cone'], remotePath)
      await provider.exec(['sparse-checkout', 'set', '--', ...sparseDirectories], remotePath)
      await provider.exec(['checkout', branchName], remotePath)
    } catch (err) {
      let rollbackSucceeded = false
      if (!checkoutExistingBranch) {
        try {
          await unsetRemoteWorktreeCreationBase(provider, remotePath, branchName)
        } catch (cleanupError) {
          console.warn(
            '[worktree-create] Failed to clear remote sparse creation base:',
            cleanupError
          )
        }
      }
      try {
        await provider.removeWorktree(remotePath, true, {
          deleteBranch: !checkoutExistingBranch,
          // Why: sparse setup failed before any work happened, so rollback removes the just-created remote branch.
          forceBranchDelete: !checkoutExistingBranch
        })
        rollbackSucceeded = true
      } catch (rollbackError) {
        console.warn('[worktree-create] Failed to roll back remote sparse worktree:', rollbackError)
      }
      if (!rollbackSucceeded && shouldRetireGeneratedName) {
        await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
      }
      throw err
    }
  }

  // Why: fallible metadata work after creation must not leave a real workspace name reusable.
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
  }

  // Re-list to get the created worktree info
  const gitWorktrees = await timing.time('list_created_worktree', async () =>
    provider.listWorktrees(repo.path)
  )
  // Match the exact requested path first, then the exact branch ref. Suffix matching can
  // select an older `prefix/<branchName>` worktree when the newly created row is present.
  const created = findCreatedWorktree(gitWorktrees, remotePath, branchName)
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  // Why: PR/MR worktrees start from a head ref/SHA but Source Control must compare against the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  // Why: `--set-upstream-to` needs the remote to exist -- true for a same-repo
  // target but not for a fork remote, which materializes lazily (#17828).
  let configuredPushTarget: GitPushTarget | undefined = preparedPushTarget
  if (preparedPushTarget && !preparedPushTarget.remoteUrl) {
    configuredPushTarget = await configureCreatedWorktreePushTargetWithExec(
      (args, cwd) => provider.exec(args, cwd),
      created.path,
      branchName,
      preparedPushTarget
    )
  }
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
    creatorProvenance: { kind: 'host' },
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...resolveWorktreeCreateDisplayNameMeta(
      requestedDisplayName,
      branchName,
      displayNameRequest.kind,
      { requestedName: effectiveRequestedName, sanitizedName: effectiveSanitizedName }
    ),
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
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  const { lineage: worktreeLineage, workspaceLineage } = recordWorkspaceLineageForCreatedWorktree(
    store,
    args,
    worktree,
    now
  )

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
            fsProvider,
            yamlHooks?.setupAgentStartupPolicy
          )
        } catch (error) {
          console.error(`[hooks] Failed to prepare setup runner for ${created.path}:`, error)
        }
      }
    })
  }

  notifyWorktreesChanged(mainWindow, repo.id)
  return {
    worktree: {
      ...worktree,
      workspaceLineage,
      ...(worktreeLineage
        ? { lineage: worktreeLineage, parentWorktreeId: worktreeLineage.parentWorktreeId }
        : {})
    },
    ...(worktreeLineage ? { lineage: worktreeLineage } : {}),
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
  const worktreePathSettings = getWorktreePathSettings(
    repo,
    settings,
    getWorktreeMirrorDistro(store, repo)
  )
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

  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  const displayNameRequest = resolveWorktreeCreateDisplayNameRequest(
    args.displayName,
    args.displayNameKind,
    args.name,
    args.cliProvenance?.kind === 'created-by-cli',
    args.nameWasGenerated === true
  )
  const requestedDisplayName = displayNameRequest.value
  // Why: explicit branches and non-username prefix modes never consume this; skipping the probe preserves the exact generated branch name.
  // Username and base resolution are independent read-only probes. Starting
  // both before awaiting removes one serial git/config round trip from create.
  const usernamePromise =
    !args.branchNameOverride && settings.branchPrefix === 'git-username'
      ? resolveLocalGitUsername(repo.path)
      : Promise.resolve('')
  const baseBranchPromise = resolveWorktreeCreateBase({
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
          return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate, localGitExecOptions)
        }
      }
      return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate, localGitExecOptions)
    }
  })
  const [username, resolvedBaseBranch] = await Promise.all([usernamePromise, baseBranchPromise])
  let baseBranch = resolvedBaseBranch
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
      const [hasRemoteTrackingBaseRef, hasNamedLocalBaseRef] = await Promise.all([
        runtime.hasRemoteTrackingRef(repo.path, remoteTrackingBase, ...localWorktreeGitOptionArgs),
        hasLocalWorktreeBaseRef(repo.path, baseBranch, localGitExecOptions)
      ])
      const hasFallbackLocalBaseRef =
        !hasNamedLocalBaseRef &&
        (await hasLocalWorktreeBaseRef(repo.path, remoteTrackingBase.branch, localGitExecOptions))
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
          promise: runtime.getOrStartRemoteTrackingBaseRefresh(
            repo.path,
            remoteTrackingBase,
            ...localWorktreeGitOptionArgs
          )
        }
      }
    } else if (!(await hasLocalWorktreeBaseRef(repo.path, baseBranch, localWorktreeGitOptions))) {
      // Why: non-remote-prefix bases (plain main/master/local) keep the legacy best-effort fetch; verified PR SHA bases already have the object.
      legacyFetchPromise = runtime
        .fetchRemoteWithCache(repo.path, 'origin', ...localWorktreeGitOptionArgs)
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  } else {
    if (!(await hasLocalWorktreeBaseRef(repo.path, baseBranch, localWorktreeGitOptions))) {
      legacyFetchPromise = gitExecFileAsync(['fetch', 'origin'], {
        ...localGitExecOptions,
        timeout: CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS
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
  const shouldRetireGeneratedName =
    args.nameWasGenerated === true && isGeneratedWorktreeCreateName(sanitizedName)
  await timing.time('resolve_name', async () => {
    const retiredNameRegistry = shouldRetireGeneratedName
      ? await getRetiredNameRegistryForRepo(store, repo, store.getRepos(), settings)
      : null
    const isRetiredName = retiredNameRegistry ? createRetiredNameLookup(retiredNameRegistry) : null
    // Why: a create-from-review branch override may already exist locally; suffix both branch and path instead of blocking the user.
    for (
      let suffix = 1, attempts = 0;
      attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS;
      suffix += 1
    ) {
      effectiveSanitizedName = shouldRetireGeneratedName
        ? getGeneratedWorktreeCreateCandidate(
            sanitizedName,
            suffix,
            retiredNameRegistry?.exhaustedTiers
          )
        : getWorktreeCreateCandidate(sanitizedName, suffix)
      effectiveRequestedName = shouldRetireGeneratedName
        ? effectiveSanitizedName
        : requestedName.trim()
          ? getWorktreeCreateCandidate(requestedName, suffix)
          : effectiveSanitizedName
      if (isRetiredName?.(effectiveSanitizedName)) {
        continue
      }
      attempts += 1
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
  })

  if (!resolved) {
    // Why: every suffix collided; reject with a specific reason so the user sees why create failed instead of a generic error or hung spinner.
    // Read once and format eagerly: the suffix loop assigns this from a callback, so the `let`'s
    // narrowing does not reach the message.
    const existingReviewNumber = lastExistingReviewNumber
    if (existingReviewNumber !== null) {
      throw new Error(
        `Branch "${branchName}" already has PR #${String(existingReviewNumber)}. Pick a different ${branchConflictSubject}.`
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

  assertAttachableParentWorkspace(
    store,
    args.parentWorkspace,
    worktreeWorkspaceKey(`${repo.id}::${worktreePath}`)
  )

  if (remoteTrackingRefresh) {
    await timing.time('refresh_base_ref', async () => {
      const result = await remoteTrackingRefresh.promise
      if (!result.ok && !remoteTrackingRefresh.hadLocalBaseRef) {
        // Why: only block create when the refresh failed AND there's no local base ref; an existing (possibly stale) ref keeps worktree add viable.
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

  // Why: defer the remote add + fetch to first push/pull/fetch/fast-forward
  // (#17828) instead of paying it at create time for a read-only review.
  const preparedPushTarget: GitPushTarget | undefined = args.pushTarget

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
  const preparedWorktreeOptions = suggestLocalBaseRefUpdate
    ? addProjectGitOptions({ ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate })
    : addProjectGitOptions(remoteTrackingBaseOption)
  let addResult: AddWorktreeResult
  try {
    addResult =
      (await timing.time('git_worktree_add', async () => {
        if (sparseDirectories.length === 0 && !checkoutExistingBranch) {
          const prepared = await consumePreparedWorktreeCreate({
            repoPath: repo.path,
            workspaceRoot,
            worktreePath,
            branch: branchName,
            baseBranch,
            refreshLocalBaseRef: settings.refreshLocalBaseRefOnWorktreeCreate,
            ...(preparedWorktreeOptions ? { options: preparedWorktreeOptions } : {})
          })
          timing.recordPreparedCheckout(
            prepared.status === 'hit'
              ? { status: 'hit', retargeted: prepared.retargeted }
              : { status: 'miss', reason: prepared.reason }
          )
          if (prepared.status === 'hit') {
            return prepared.result
          }
        } else {
          timing.recordPreparedCheckout({
            status: 'miss',
            reason: sparseDirectories.length > 0 ? 'sparse_checkout' : 'checkout_existing_branch'
          })
        }
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
    if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
      await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
    }
    throw error
  }

  // Why: fallible metadata work after creation must not leave a real workspace name reusable.
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
  }

  // Why: `--set-upstream-to` needs the remote to exist -- true for a same-repo
  // target but not for a fork remote, which materializes lazily (#17828).
  let configuredPushTarget: GitPushTarget | undefined = preparedPushTarget
  if (preparedPushTarget && !preparedPushTarget.remoteUrl) {
    configuredPushTarget = await configureCreatedWorktreePushTarget(
      worktreePath,
      branchName,
      preparedPushTarget,
      localWorktreeGitOptions
    )
  }

  // Re-list to get the freshly created worktree info
  const {
    created,
    worktrees: gitWorktrees,
    listingComplete
  } = await timing.time('list_created_worktree', async () =>
    resolveCreatedWorktree(
      repo.path,
      worktreePath,
      branchName,
      hasLocalWorktreeGitOptions ? localWorktreeGitOptions : undefined
    )
  )

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
    creatorProvenance: { kind: 'host' },
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...resolveWorktreeCreateDisplayNameMeta(
      requestedDisplayName,
      branchName,
      displayNameRequest.kind,
      { requestedName: effectiveRequestedName, sanitizedName: effectiveSanitizedName }
    ),
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
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  const { lineage: worktreeLineage, workspaceLineage } = recordWorkspaceLineageForCreatedWorktree(
    store,
    args,
    worktree,
    now
  )
  // Why: reuse the roots creation already paid for via `git worktree list` so later IPC doesn't lazily rescan and trip macOS privacy prompts.
  // Why gated: registration replaces the repo's root set, so registering a create recovered without
  // a listing would revoke filesystem access to every worktree that listing would have named.
  if (listingComplete) {
    registerWorktreeRootsForRepo(store, repo.id, [
      repo.path,
      ...gitWorktrees.map((worktree) => worktree.path)
    ])
  } else {
    // Recovered without a listing: authorize just the new root, or the create the user just made
    // is rejected by filesystem/git-status IPC until a full scan repopulates the cache.
    registerCreatedWorktreeRoot(store, repo.id, created.path)
  }

  // Why: link user-configured shared paths (e.g. `node_modules`, `.env`) before setup runs so setup scripts see them in place.
  const symlinkPaths = repo.symlinkPaths ?? []
  if (symlinkPaths.length > 0) {
    await timing.time('create_symlinks', async () => {
      await createWorktreeLinkedPaths(repo.path, created.path, symlinkPaths)
    })
  }

  // Why: project-level `orca.yaml` shared directories add to (never replace) the per-user
  // setting, so a repo's shared dirs reach every teammate (issue #10451).
  const [sharedDirectories, includePaths] = await Promise.all([
    timing.time('resolve_shared_directories', () =>
      resolveWorktreeSharedDirectories(repo.path, localWorktreeGitOptions)
    ),
    timing.time('resolve_worktreeinclude', () =>
      resolveWorktreeIncludePaths(repo.path, localWorktreeGitOptions)
    )
  ])
  if (sharedDirectories.length > 0) {
    await timing.time('create_shared_directories', async () => {
      await createWorktreeSharedPaths(repo.path, created.path, sharedDirectories)
    })
  }

  // Why: project-level `.worktreeinclude` travels with the repo (issue #7549); copy semantics
  // (never symlink) so each worktree owns its files. Paths already linked above are skipped.
  let includeCopyWarning: string | undefined
  if (includePaths.length > 0) {
    await timing.time('copy_worktreeinclude', async () => {
      const skippedIncludePaths = await createWorktreeCopiedPaths(
        repo.path,
        created.path,
        includePaths
      )
      includeCopyWarning = formatWorktreeIncludeCopyWarning(skippedIncludePaths)
      if (includeCopyWarning) {
        console.warn(`[worktree-include] ${includeCopyWarning}`)
      }
    })
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
        setup = createSetupRunnerScript(
          repo,
          worktreePath,
          setupScript,
          localWorktreeGitOptionArgs[0],
          resolveSetupRunnerShell(settings),
          createdYamlHooks?.setupAgentStartupPolicy
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
    worktree: {
      ...worktree,
      workspaceLineage,
      ...(worktreeLineage
        ? { lineage: worktreeLineage, parentWorktreeId: worktreeLineage.parentWorktreeId }
        : {})
    },
    ...(worktreeLineage ? { lineage: worktreeLineage } : {}),
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
