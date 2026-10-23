/* eslint-disable max-lines */
// Why: worktree create helpers (local + remote) split out of worktrees.ts; the cohesive create flow runs this file just over the per-file line limit.

import { worktreeCreateGit } from '../git/worktree-create-git-executor'
import { getStoredRepoExecutionHostId } from '../repo-execution-host'
import type { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import type { Repo } from '../../shared/repo-types'
import type {
  CreateWorktreeArgs,
  CreateWorktreeProgressEvent,
  CreateWorktreeResult,
  WorktreeCheckoutProgress,
  WorktreeCreateBaseFallback
} from '../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  GitStatusMetadataChangedEvent,
  Worktree,
  WorktreeHeadIdentity
} from '../../shared/worktree/types'
import { getPRForBranch } from '../github/client'
import { listWorktrees, addWorktree, addSparseWorktree } from '../git/worktree'
import type { AddWorktreeOptions, AddWorktreeResult } from '../git/worktree'
import {
  consumePreparedWorktreeCreate,
  type PreparationRearmHolder
} from '../worktree-create-preparation'
import { getBranchConflictKind, resolveDefaultBaseRefWithLocalGit } from '../git/repo'
import { WorktreeCreateCollisionError } from '../../shared/new-workspace/worktree-create-collision'
import { resolveLocalGitUsername } from '../git/git-username'
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import type { ForgeProviderId } from '../source-control/forge-provider'
import { validateGitPushTarget } from '../git/push-target-validation'
import { gitExecFileAsync } from '../git/runner'
import type {
  OrcaRuntimeService,
  RemoteFetchResult,
  RemoteTrackingBase
} from '../runtime/orca-runtime'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { getEffectiveHooks, loadHooks } from '../hooks'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import {
  getDefaultTabsLaunch,
  getEffectiveHooksFromConfig,
  shouldRunSetupForCreate
} from '../effective-hook-config'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { runWorktreeChangeInvalidators } from './worktree-change-invalidators'

type CreateWorktreeArgsWithSystemProvenance = CreateWorktreeArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
  cliProvenance?: CliWorkspaceProvenance
}
import {
  sanitizeWorktreeName,
  computeWorktreePath,
  computeWorkspaceRootAsync,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings
} from './worktree-logic'
import {
  resolveWorktreeCreateDisplayNameRequest,
  resolveWorktreeCreateDisplayNameMeta
} from './worktree-display-name'
import { computeValidatedBranchName } from './worktree-branch-name'
import { mergeWorktree } from './worktree-metadata-merge'
import { resolveCreatedWorktree } from './created-worktree-reconciliation'
import { notifyLineageRepos } from '../worktree-lineage-change-notification'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { BranchPrefixSettings } from '../../shared/branch-prefix'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { sharesWorktreeLineageBoundary } from '../../shared/resolved-worktree-lineage'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  sameGitHubRemoteUrl,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'
import { reconcileOrphanedPrRemotes } from './worktree-push-target-reconciliation'
import {
  configureCreatedWorktreePushTargetWithExec,
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
import { attributedSparsePresetId } from './sparse-preset-attribution'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../shared/setup-runner-command'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import {
  createWorktreeCreateTimingRecorder,
  localWorktreeCreateExecutionHost,
  type WorktreeCreateTimingRecorder
} from '../worktree-create-timing'
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
import { findPendingWorktreeRemovalConflict } from '../worktree-removal-table'
import { isWslMoveWorktreeBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'
import {
  hostWorktreeTargetForRepo,
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost,
  worktreeRowTarget
} from '../persistence/host-qualified-worktree-meta'
// Why: bound the fallback `git fetch origin` so a Windows credential-manager GUI hang (STA-1292) can't wedge worktree creation forever.
const CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS = 60_000
// Why (#17828 CodeRabbit follow-up): the deferred materialize fetch runs off the main
// create path (terminal spawn, mid-session sync) with nothing else bounding it -- same
// STA-1292 hang risk as the create-time fallback above, so mirror its timeout.
const DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS = 60_000
// Why (#17828 CodeRabbit follow-up): a terminal spawn and an explicit sync action can
// both call materialize for the same worktree remote at once; without single-flighting,
// the loser's `remote add` races the winner's fetch and can strand a duplicate remote.
const worktreePushTargetMaterializeInflight = new Map<string, Promise<GitPushTarget>>()

function worktreePushTargetMaterializeKey(repoPath: string, remoteName: string): string {
  return `${repoPath}::${remoteName}`
}

type StagedStartupResult = {
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  activationSetup?: CreateWorktreeResult['setup']
  didSpawnSetup: boolean
  warning?: string
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
    parentScope.type === 'worktree'
      ? ((worktree.hostId
          ? readWorktreeMetaForHost(store, parentScope.worktreeId, worktree.hostId)
          : undefined) ?? store.getWorktreeMeta(parentScope.worktreeId))
      : null
  if (parentScope.type === 'worktree' && !parentWorktreeMeta) {
    console.warn(`[worktree-create] parent worktree workspace disappeared: ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }

  // Why: only a worktree parent produces sidebar nesting; a folder parent has no WorktreeLineage row.
  let lineage: CreateWorktreeResult['lineage'] = null
  let parentOutsideLineageBoundary = false
  let lineageOwnedByTwin = false
  if (parentScope.type === 'worktree' && parentWorktreeMeta) {
    if (!parentWorktreeMeta.instanceId) {
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} has no instance identity; skipping lineage`
      )
    } else if (!sharesWorktreeLineageBoundary(worktree, parentWorktreeMeta)) {
      parentOutsideLineageBoundary = true
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} is outside ${worktree.id}'s execution host; skipping lineage`
      )
    } else {
      const target = worktreeRowTarget(store, worktree)
      lineage =
        (target &&
          store.setWorktreeLineage(target, {
            worktreeId: worktree.id,
            worktreeInstanceId: worktree.instanceId,
            parentWorktreeId: parentScope.worktreeId,
            parentWorktreeInstanceId: parentWorktreeMeta.instanceId,
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt
          })) ??
        null
      lineageOwnedByTwin = lineage === null
    }
  }

  // Why: a workspace row for an out-of-boundary worktree parent is a cross-host link that survives restarts.
  // A twin-owned bucket keeps the twin's workspace row too.
  if (parentOutsideLineageBoundary || lineageOwnedByTwin) {
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

async function spawnLocalStartupAndSetupTerminals(args: {
  runtime: OrcaRuntimeService
  worktree: Worktree
  startup: CreateWorktreeArgs['startup']
  setup: CreateWorktreeResult['setup']
  defaultTabs: CreateWorktreeResult['defaultTabs']
  createdWithAgent: CreateWorktreeArgs['createdWithAgent']
}): Promise<StagedStartupResult> {
  const { runtime, worktree, startup, setup, defaultTabs, createdWithAgent } = args
  if (!startup || defaultTabs?.tabs.length) {
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
    const terminal = await runtime.createTerminal(
      `id:${worktree.id}`,
      {
        command: sequencedStartup.command,
        ...(setup ? { claudeAgentTeamsSourceCommand: startup.command } : {}),
        env: sequencedStartup.env,
        ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
        ...(isTuiAgent(createdWithAgent) ? { launchAgent: createdWithAgent } : {}),
        ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
        startupCommandDelivery: sequencedStartup.startupCommandDelivery,
        telemetry: sequencedStartup.telemetry,
        // Why: the submitting renderer decides whether to open the workspace; activating here yanked users who moved on (#9944).
        surfaceOwner: false
      },
      worktree
    )
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
      await runtime.createTerminal(
        `id:${worktree.id}`,
        {
          title: 'Setup',
          command: setupCommand,
          env: setup.envVars,
          activate: false,
          surfaceOwner: false
        },
        worktree
      )
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
    executionHostId: getStoredRepoExecutionHostId(repo),
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

export async function prepareWorktreePushTarget(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore | null,
  repoId?: string,
  gitOptions: { wslDistro?: string } = {},
  // Ownership evidence comes only from the host this git runs on.
  hostId?: ExecutionHostId
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
            repoId,
            hostId
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
/** The copy an IPC git handler ran on: the route it already required names the host. */
export function ipcGitWorktreeTarget(args: {
  worktreeId?: string
  connectionId?: string
}): HostWorktreeTarget | undefined {
  return args.worktreeId
    ? hostWorktreeTarget({
        id: args.worktreeId,
        hostId: getConnectionExecutionHostId(args.connectionId)
      })
    : undefined
}

export async function materializeWorktreePushTargetRemote(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore | null,
  repoId?: string,
  gitOptions: { wslDistro?: string } = {},
  // The copy whose git ran here: an id alone cannot name one of two hosts' twins.
  worktree?: HostWorktreeTarget
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
        worktree
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
        worktree
      )
    )
  }
  const promise = prepareWorktreePushTarget(
    repoPath,
    target,
    store,
    repoId,
    gitOptions,
    worktree?.hostId
  )
    .then((prepared) => restoreUpstreamAfterMaterialize(execGit, repoPath, prepared))
    .then((prepared) => {
      persistMaterializedPushTargetIfCreated(store, worktree, prepared)
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
  store: WorktreePushTargetStore | null | undefined,
  repoId: string | undefined,
  worktree: HostWorktreeTarget | undefined
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
  const ownerRepoId = repoId ?? (worktree ? getRepoIdFromWorktreeId(worktree.id) : undefined)
  const owned =
    store !== undefined &&
    ownerRepoId !== undefined &&
    // SAFETY: Legacy null keeps this branch's original failure rather than introducing a fallback.
    isPushTargetRemoteCreatedByKnownWorktree(store!, restored, ownerRepoId, worktree?.hostId)
  const adopted = owned ? { ...restored, remoteCreated: true } : restored
  persistMaterializedPushTargetIfCreated(store, worktree, adopted)
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
  store: WorktreePushTargetStore | null | undefined,
  worktree: HostWorktreeTarget | undefined,
  target: GitPushTarget
): void {
  if (!target.remoteCreated || !worktree || !store?.setWorktreeMeta) {
    return
  }
  const repoId = getRepoIdFromWorktreeId(worktree.id)
  const repos = store.getRepos?.()
  // A copy whose repo this host no longer has gets no new row.
  if (
    repos &&
    !repos.some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === worktree.hostId)
  ) {
    return
  }
  // Bookkeeping incidental to the push: a project a WSL move is taking skips it, not the push.
  if (isWslMoveWorktreeBlocked(worktree.id, worktree.hostId)) {
    return
  }
  store.setWorktreeMeta(worktree, { pushTarget: target })
}

function isPushTargetRemoteCreatedByKnownWorktree(
  store: WorktreePushTargetStore,
  target: GitPushTarget,
  repoId?: string,
  // A same-id twin's remote on another host proves nothing about this host's remote.
  hostId?: ExecutionHostId
): boolean {
  const rows = hostId ? readAllWorktreeMetaForHost(store, hostId) : store.getAllWorktreeMeta()
  return Object.entries(rows).some(([worktreeId, meta]) => {
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
  gitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {}
): Promise<GitPushTarget> {
  return configureCreatedWorktreePushTargetWithExec(
    (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
    worktreePath,
    branchName,
    target
  )
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
  repoId: string,
  worktreePaths: readonly string[] | null = null
): void {
  // Why: index churn is a Source Control freshness hint, not a graph mutation; leave structural caches and runtime/mobile events untouched.
  if (!mainWindow.isDestroyed()) {
    const payload: GitStatusMetadataChangedEvent = worktreePaths
      ? { repoId, worktreePaths: [...worktreePaths] }
      : { repoId }
    mainWindow.webContents.send('worktrees:gitStatusMetadataChanged', payload)
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
// `checkout` carries git's checkout meter during 'creating'; null means the checkout finished.
export function emitCreateWorktreeProgress(
  mainWindow: BrowserWindow,
  phase: 'fetching' | 'creating',
  creationId?: string,
  checkout?: WorktreeCheckoutProgress | null
): void {
  if (!mainWindow.isDestroyed()) {
    const event: CreateWorktreeProgressEvent = {
      creationId,
      phase,
      ...(checkout !== undefined ? { checkout } : {})
    }
    mainWindow.webContents.send('createWorktree:progress', event)
  }
}

export function createLocalWorktree(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService,
  timing: WorktreeCreateTimingRecorder = createWorktreeCreateTimingRecorder(),
  onWorkspaceCreated?: (worktreeId: string) => void
): Promise<CreateWorktreeResult> {
  // Why a holder fired in `finally`: consuming a prepared checkout leaves the pool one short, so a
  // create that fails after that point — include copy, push target, terminal startup — must still
  // arm the replacement. Fires exactly once, after startup on the success path.
  const rearm: PreparationRearmHolder = { fire: () => {} }
  return worktreeCreateGit
    .run(() =>
      performLocalWorktreeCreate(
        args,
        repo,
        store,
        mainWindow,
        rearm,
        timing,
        runtime,
        onWorkspaceCreated
      )
    )
    .finally(() => {
      // Closes the create's measured window first, so its own re-arm is not counted against it.
      timing.finish()
      rearm.fire()
    })
}

async function performLocalWorktreeCreate(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow,
  rearm: PreparationRearmHolder,
  timing: WorktreeCreateTimingRecorder,
  runtime: OrcaRuntimeService,
  onWorkspaceCreated?: (worktreeId: string) => void
): Promise<CreateWorktreeResult> {
  const settings = store.getSettings()
  const worktreePathSettings = getWorktreePathSettings(
    repo,
    settings,
    getWorktreeMirrorDistro(store, repo)
  )
  const localGitExecOptions = getLocalProjectGitExecOptions(store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  timing.recordExecutionHost(localWorktreeCreateExecutionHost(localGitExecOptions))
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }] = hasLocalWorktreeGitOptions
    ? [localWorktreeGitOptions]
    : []
  const creationId = args.creationId
  // Why: only `git worktree add` reads onCheckoutProgress; a prepared-checkout claim never reports.
  const addProjectGitOptions = (options?: AddWorktreeOptions): AddWorktreeOptions => ({
    ...options,
    ...localWorktreeGitOptions,
    ...(creationId
      ? {
          onCheckoutProgress: (checkout: WorktreeCheckoutProgress | null) =>
            emitCreateWorktreeProgress(mainWindow, 'creating', creationId, checkout)
        }
      : {})
  })

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
    } else if (!(await hasLocalWorktreeBaseRef(repo.path, baseBranch, localGitExecOptions))) {
      // Why: non-remote-prefix bases (plain main/master/local) keep the legacy best-effort fetch; verified PR SHA bases already have the object.
      legacyFetchPromise = runtime
        .fetchRemoteWithCache(repo.path, 'origin', ...localWorktreeGitOptionArgs)
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  } else {
    if (!(await hasLocalWorktreeBaseRef(repo.path, baseBranch, localGitExecOptions))) {
      legacyFetchPromise = gitExecFileAsync(['fetch', 'origin'], {
        ...localGitExecOptions,
        timeout: CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS
      })
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  }
  const workspaceRoot = await computeWorkspaceRootAsync(repo.path, worktreePathSettings)

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
  const sparsePresetId = attributedSparsePresetId(
    () => store.getSparsePresets(repo.id),
    repo.id,
    args.sparseCheckout?.presetId,
    sparseDirectories
  )

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
      const tryExistingBranch = async (): Promise<boolean> => {
        checkoutExistingBranch = await canCheckoutExistingLocalBranch(
          repo.path,
          branchName,
          baseBranch,
          localWorktreeGitOptions
        )
        return checkoutExistingBranch
      }
      // Explicit branch selections retain the adoption-first path.
      const preferExistingBranch = Boolean(
        args.branchNameOverride || selectedExistingLocalBranchName
      )
      checkoutExistingBranch = preferExistingBranch && (await tryExistingBranch())
      lastBranchConflictKind = checkoutExistingBranch
        ? null
        : await getBranchConflictKind(
            repo.path,
            branchName,
            baseBranch,
            localWorktreeGitOptions,
            preferExistingBranch ? undefined : tryExistingBranch
          )
      if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
        // Path retries must retain the adopted branch.
        selectedExistingLocalBranchName = branchName
      }
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
        computeWorktreePath(effectiveSanitizedName, repo.path, worktreePathSettings, workspaceRoot),
        workspaceRoot
      )
      // Why the pending check: Git may already have deleted the directory while Orca still owns
      // the path until its removal settles; take the next name instead of racing it.
      if (
        existsSync(worktreePath) ||
        findPendingWorktreeRemovalConflict(repo.path, { worktreePath })
      ) {
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
      throw new WorktreeCreateCollisionError(
        `Branch "${branchName}" already has PR #${String(existingReviewNumber)}. Pick a different ${branchConflictSubject}.`
      )
    }
    if (lastBranchConflictKind) {
      throw new WorktreeCreateCollisionError(
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
  const preparedWorktreeOptions = addProjectGitOptions(
    suggestLocalBaseRefUpdate
      ? { ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate }
      : remoteTrackingBaseOption
  )
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
            options: preparedWorktreeOptions,
            timing
          })
          if (prepared.status === 'hit') {
            // Why deferred: re-arming is a full `reset --hard`; started here it would hold a
            // general admission slot for the rest of this create's own git.
            rearm.fire = prepared.rearm
            return prepared.result
          }
          if (prepared.rearm) {
            rearm.fire = prepared.rearm
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
          return addSparseWorktree(
            repo.path,
            worktreePath,
            branchName,
            sparseDirectories,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            addProjectGitOptions(remoteTrackingBaseOption)
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
        return addWorktree(
          repo.path,
          worktreePath,
          branchName,
          baseBranch,
          settings.refreshLocalBaseRefOnWorktreeCreate,
          false,
          addProjectGitOptions(remoteTrackingBaseOption)
        )
      })) ?? {}
  } catch (error) {
    if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
      await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
    }
    throw error
  }
  // Why: the worktree is listable from here on. Every scan that started earlier -- including a
  // prepared checkout's, which listings hide while it is still locked -- now describes a catalog
  // without it, and must not be served or cached as the current one.
  runWorktreeChangeInvalidators(repo.id)

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
    resolveCreatedWorktree(repo.path, worktreePath, branchName, localWorktreeGitOptions)
  )
  if (listingComplete) {
    timing.recordWorktreeCount(gitWorktrees.length)
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
    // createdAt protects the new worktree from ambient PTY bumps for CREATE_GRACE_MS.
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
    ...(args.linkedItems !== undefined ? { linkedItems: args.linkedItems } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  onWorkspaceCreated?.(worktreeId)
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
    registerWorktreeRootsForRepo(
      store,
      repo,
      [repo.path, ...gitWorktrees.map((worktree) => worktree.path)],
      localWorktreeGitOptions
    )
  } else {
    // Recovered without a listing: authorize just the new root, or the create the user just made
    // is rejected by filesystem/git-status IPC until a full scan repopulates the cache.
    registerCreatedWorktreeRoot(store, repo, created.path)
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

  // Startup resolves the new id before lifecycle notifications invalidate runtime caches.
  runtime?.invalidateWorktreeCatalog?.(repo.id)
  const stagedStartup = await timing.time('spawn_startup_terminal', () =>
    spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree,
      startup: args.startup,
      setup,
      defaultTabs,
      createdWithAgent: args.createdWithAgent
    })
  )

  // Why: an automation's terminals start in main, so the window is handed none to launch.
  const provisionedByHost = Boolean(args.automationProvenance)
  if (provisionedByHost && (setup || defaultTabs?.tabs.length)) {
    void runtime.provisionManagedWorktreeTerminals(
      {
        worktreeSelector: `id:${worktree.id}`,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        ...(setup ? { setup } : {}),
        ...(defaultTabs ? { defaultTabs } : {}),
        hasStartupTerminal: false,
        setupCommandPlatform: getSetupRunnerCommandPlatformForLaunch(setup, 'posix'),
        surfaceOwner: false
      },
      worktree
    )
  }

  notifyLineageRepos(
    (repoId) => notifyWorktreesChanged(mainWindow, repoId),
    repo.id,
    worktreeLineage?.parentWorktreeId
  )
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
    ...(provisionedByHost
      ? {}
      : {
          ...(stagedStartup.activationSetup
            ? { setup: stagedStartup.activationSetup }
            : setup && !stagedStartup.didSpawnSetup
              ? { setup }
              : {}),
          ...(defaultTabs ? { defaultTabs } : {})
        }),
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
