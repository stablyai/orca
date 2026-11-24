import {
  captureWorktreeCheckoutIdentity,
  assertWorktreeCheckoutIdentity
} from '../removal/worktree-checkout-identity'
import type { WorktreeCheckoutIdentity } from '../../../shared/worktree/removal/worktree-checkout-identity'
import type {
  WorkspaceCleanupPolicyState,
  WorkspaceCleanupPolicyChange
} from '../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import {
  folderGroupOf,
  folderSiblingsByWorktree,
  hasUnlistedFolderSibling,
  projectFolderGroups,
  summaryHostId,
  summaryIdentity
} from './workspace-cleanup-folder-membership'
import {
  pairedFolderChildrenOnce,
  type PairedFolderChildren
} from './workspace-cleanup-paired-folder-children'
import { dirtyEditorWorktreeIds, scanTargets } from './workspace-cleanup-run-git-evidence'
import { createCleanupRemovalRouteCheck } from './workspace-cleanup-removal-route'
import { runtimeVisibleRepos } from '../../runtime/workspaces/catalog/runtime-visible-catalog'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  isRepoOnCatalogHost,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  getPersistedWorkspaceCleanupActivityAt,
  type WorkspaceCleanupBlocker
} from '../../../shared/workspace-cleanup/workspace-cleanup'
import {
  resolveWorkspaceCleanupPolicy,
  type ResolvedWorkspaceCleanupPolicy,
  type WorkspaceCleanupRules
} from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupEvaluationInput } from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import type { WorkspaceCleanupWorkspaceRef } from '../../../shared/workspace-cleanup/workspace-cleanup-run'
import { shortWorkspaceCleanupBranchName } from '../../../shared/workspace-cleanup/workspace-cleanup-candidate-fields'
import type { WorkspaceCleanupPaneAgentStates } from './workspace-cleanup-terminal-activity'

const DAY_MS = 24 * 60 * 60 * 1000
const WORKTREE_PS_LIMIT = 100_000
const LIVE_AGENT_STATES = new Set(['working', 'blocked', 'waiting'])

export type WorkspaceCleanupWorkspace = {
  checkoutIdentity?: WorktreeCheckoutIdentity
  ref: WorkspaceCleanupWorkspaceRef
  repo: Repo
  policy: ResolvedWorkspaceCleanupPolicy
  nextPolicy?: ResolvedWorkspaceCleanupPolicy
  input: WorkspaceCleanupEvaluationInput
  paneAgentStates: WorkspaceCleanupPaneAgentStates
  removing: boolean
  /** Guarded removal would refuse this checkout's route, so it is never offered for deletion. */
  removalRouteUnverifiable?: true
  /** Its host identity; every workspace here is this host's. */
  identity: string
  /** The host identities of the other worktrees its folder workspace lists, on any host. */
  folderSiblings: string[]
  readPairedFolderChildren: () => Promise<PairedFolderChildren>
}

/** Repos whose checkouts this process owns; a host served by its own orcad is that server's to clean. */
export function listWorkspaceCleanupOwnedRepos(store: RuntimeStore): Map<string, Repo> {
  const repos = new Map<string, Repo>()
  for (const repo of runtimeVisibleRepos(store)) {
    if (isRepoOnCatalogHost(repo) && !isFolderRepo(repo)) {
      repos.set(repo.id, repo)
    }
  }
  return repos
}

function isOwnedSummary(summary: RuntimeWorktreePsSummary, repos: Map<string, Repo>): boolean {
  return (
    repos.has(summary.repoId) &&
    summaryHostId(summary) === LOCAL_EXECUTION_HOST_ID &&
    summary.workspaceKind !== 'folder-workspace'
  )
}

function summaryActivityAt(summary: RuntimeWorktreePsSummary): number {
  return getPersistedWorkspaceCleanupActivityAt({
    lastActivityAt: summary.lastActivityAt ?? 0,
    createdAt: summary.createdAt
  })
}

/** Git evidence costs a status and merge proof per checkout; skip it where no enabled rule can fire. */
function needsGitEvidence(
  summary: RuntimeWorktreePsSummary,
  rules: WorkspaceCleanupRules,
  now: number
): boolean {
  if (summary.isMainWorktree || summary.isPinned) {
    return false
  }
  // These reasons come only from the scan's Git and run/worker evidence.
  if (
    rules.merged.enabled ||
    rules.unchanged.enabled ||
    rules.automationRuns.enabled ||
    rules.orchestrationWorkers.enabled
  ) {
    return true
  }
  // Filesystem activity can only make a workspace newer, so the persisted stamp bounds the inactive rule.
  return (
    rules.inactive.enabled && now - summaryActivityAt(summary) >= rules.inactive.afterDays * DAY_MS
  )
}

function inputWithoutGit(summary: RuntimeWorktreePsSummary): WorkspaceCleanupEvaluationInput {
  const blockers: WorkspaceCleanupBlocker[] = []
  if (summary.isMainWorktree) {
    blockers.push('main-worktree')
  }
  if (summary.isPinned) {
    blockers.push('pinned')
  }
  return {
    reasons: [],
    blockers,
    lastActivityAt: summaryActivityAt(summary),
    git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
  }
}

function withHostBlockers(
  input: WorkspaceCleanupEvaluationInput,
  summary: RuntimeWorktreePsSummary,
  agentLive: boolean,
  dirtyEditor: boolean
): WorkspaceCleanupEvaluationInput {
  const blockers = [...input.blockers]
  if (agentLive) {
    blockers.push('live-agent')
  }
  // The workspace a window or phone has open; removing it would pull it out from under the user.
  if (summary.isActive) {
    blockers.push('active-workspace')
  }
  // Old hosts omit the count; current ones send zero, so absence is unknown liveness.
  if (summary.unverifiableTerminalCount !== 0) {
    blockers.push('terminal-liveness-unknown')
  }
  if (dirtyEditor) {
    blockers.push('dirty-editor-buffer')
  }
  return { ...input, blockers }
}

/** Every workspace this process owns, with the evidence the evaluator reads; one id narrows it for a
 * re-check, to that workspace and its folder siblings as listed now when `withFolderSiblings` is set. */
export async function collectWorkspaceCleanupWorkspaces(args: {
  store: RuntimeStore
  runtime: OrcaRuntimeService
  globalRules: WorkspaceCleanupRules
  now: number
  worktreeId?: string
  withFolderSiblings?: boolean
  /** The scan's read of paired servers, so a re-check never asks them again. */
  readPairedFolderChildren?: () => Promise<PairedFolderChildren>
  comparison?: { state: WorkspaceCleanupPolicyState; change: WorkspaceCleanupPolicyChange }
  requireComplete?: boolean
  freshInventory?: boolean
  captureCheckoutIdentity?: boolean
  signal?: AbortSignal
}): Promise<WorkspaceCleanupWorkspace[]> {
  const { store, runtime, globalRules, now, worktreeId, signal } = args
  const repos = listWorkspaceCleanupOwnedRepos(store)
  // A re-check projects only its target, so M removals don't rebuild the whole host's listing M times;
  // a folder member needs the whole listing to see who is in its folder now.
  const ps = await runtime.getWorktreePs(
    WORKTREE_PS_LIMIT,
    true,
    false,
    args.withFolderSiblings ? undefined : worktreeId,
    args.comparison?.state.repoId ?? undefined,
    args.freshInventory
  )
  if (ps.truncated) {
    throw new Error('Could not list every workspace on this host.')
  }
  const readPairedFolderChildren =
    args.readPairedFolderChildren ?? pairedFolderChildrenOnce(runtime)
  const projectId = args.comparison?.state.repoId ?? undefined
  let listed = ps.worktrees
  let folderSiblingsOf = await folderSiblingsByWorktree(store, listed, readPairedFolderChildren)
  if (projectId && hasUnlistedFolderSibling(listed, folderSiblingsOf)) {
    // A folder workspace can span projects, and a run judges its worktrees as one group: a project's
    // preview reads the other projects' members too, so it shows what the run would remove.
    // A consent comparison needs every member's project listed: a sibling project whose listing failed
    // must fail the preview, not drop out of the group and let the change look harmless.
    const all = await runtime.getWorktreePs(
      WORKTREE_PS_LIMIT,
      true,
      false,
      undefined,
      undefined,
      Boolean(args.comparison) || args.freshInventory
    )
    if (all.truncated) {
      throw new Error('Could not list every workspace on this host.')
    }
    listed = [...listed, ...all.worktrees.filter((summary) => summary.repoId !== projectId)]
    folderSiblingsOf = await folderSiblingsByWorktree(store, listed, readPairedFolderChildren)
  }
  const owned = listed.filter((summary) => isOwnedSummary(summary, repos))
  const summaries =
    worktreeId !== undefined
      ? args.withFolderSiblings
        ? folderGroupOf(owned, worktreeId, folderSiblingsOf)
        : owned.filter((summary) => summary.worktreeId === worktreeId)
      : projectId
        ? projectFolderGroups(owned, projectId, folderSiblingsOf)
        : owned
  const policies = new Map<string, ResolvedWorkspaceCleanupPolicy>()
  const nextPolicies = new Map<string, ResolvedWorkspaceCleanupPolicy>()
  const saved = new Map(args.comparison?.state.projects.map((row) => [row.id, row.policy]))
  for (const summary of summaries) {
    if (policies.has(summary.repoId)) {
      continue
    }
    const repo = repos.get(summary.repoId)!
    // A project preview reviews its own saved policy; a folder sibling's project keeps its current one.
    const policy = saved.has(repo.id) ? saved.get(repo.id) : repo.workspaceCleanupPolicy
    const current = resolveWorkspaceCleanupPolicy(
      { workspaceCleanupPolicy: globalRules },
      { workspaceCleanupPolicy: policy ?? undefined }
    )
    policies.set(repo.id, current)
    const change = args.comparison?.change
    const proposed =
      change?.scope === 'project' && change.repoId === repo.id ? change.policy : policy
    const nextRules = change?.scope === 'global' ? change.rules : globalRules
    nextPolicies.set(
      repo.id,
      resolveWorkspaceCleanupPolicy(
        { workspaceCleanupPolicy: nextRules },
        { workspaceCleanupPolicy: proposed ?? undefined }
      )
    )
  }
  const gitTargets = summaries
    .filter((summary) => {
      const rules = policies.get(summary.repoId)!.rules
      return (
        needsGitEvidence(summary, rules, now) ||
        needsGitEvidence(summary, nextPolicies.get(summary.repoId)!.rules, now)
      )
    })
    .map((summary) => summary.worktreeId)
  const target = args.captureCheckoutIdentity
    ? summaries.find((row) => row.worktreeId === worktreeId)
    : undefined
  const checkoutIdentity = target?.worktreeInstanceId
    ? await captureWorktreeCheckoutIdentity(
        target.path,
        target.worktreeInstanceId,
        repos.get(target.repoId)!.path
      )
    : undefined
  const candidates = await scanTargets(
    store,
    runtime,
    gitTargets,
    signal,
    args.comparison ? listed.length : undefined,
    args.requireComplete ?? Boolean(args.comparison)
  )
  if (checkoutIdentity) {
    await assertWorktreeCheckoutIdentity(checkoutIdentity)
  }
  const dirtyEditors = dirtyEditorWorktreeIds(store, runtime)
  const scanned = new Set(gitTargets)
  const routeUnverifiable = createCleanupRemovalRouteCheck(store)
  return summaries.map((summary) => {
    const repo = repos.get(summary.repoId)!
    const candidate = candidates.get(summary.worktreeId)
    const agentLive = summary.agents.some((agent) => LIVE_AGENT_STATES.has(agent.state))
    const paneAgentStates = new Map(summary.agents.map((agent) => [agent.paneKey, agent.state]))
    // A target Git no longer lists carries no evidence, so it can only be kept.
    const baseInput: WorkspaceCleanupEvaluationInput = candidate
      ? candidate
      : scanned.has(summary.worktreeId)
        ? { ...inputWithoutGit(summary), blockers: ['git-status-error'] }
        : inputWithoutGit(summary)
    return {
      ...(summary.worktreeId === worktreeId && checkoutIdentity ? { checkoutIdentity } : {}),
      ref: {
        worktreeId: summary.worktreeId,
        ...(summary.worktreeInstanceId ? { instanceId: summary.worktreeInstanceId } : {}),
        ...(candidate?.executionHostId ? { executionHostId: candidate.executionHostId } : {}),
        repoId: repo.id,
        repoName: repo.displayName,
        displayName: summary.displayName,
        branch: shortWorkspaceCleanupBranchName(summary.branch),
        path: summary.path
      },
      repo,
      policy: policies.get(summary.repoId)!,
      ...(args.comparison ? { nextPolicy: nextPolicies.get(summary.repoId)! } : {}),
      input: withHostBlockers(
        baseInput,
        summary,
        agentLive,
        dirtyEditors.has(worktreeIdentityKey(summary.worktreeId))
      ),
      paneAgentStates,
      removing: summary.removing === true,
      ...(routeUnverifiable(repo, summary.path) ? { removalRouteUnverifiable: true as const } : {}),
      identity: summaryIdentity(summary),
      folderSiblings: folderSiblingsOf(summary),
      readPairedFolderChildren
    }
  })
}
