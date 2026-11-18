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
  summaryHostId,
  summaryIdentity
} from './workspace-cleanup-folder-membership'
import {
  pairedFolderChildrenOnce,
  type PairedFolderChildren
} from './workspace-cleanup-paired-folder-children'
import { listClientUnsavedEditorWorktreeIds } from './workspace-cleanup-client-unsaved-editors'
import { runtimeVisibleRepos } from '../../runtime/workspaces/catalog/runtime-visible-catalog'
import { scanWorkspaceCleanup } from '../../ipc/workspace-cleanup/workspace-cleanup-scan'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  isRepoOnCatalogHost,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  getPersistedWorkspaceCleanupActivityAt,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate
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
  ref: WorkspaceCleanupWorkspaceRef
  repo: Repo
  policy: ResolvedWorkspaceCleanupPolicy
  nextPolicy?: ResolvedWorkspaceCleanupPolicy
  input: WorkspaceCleanupEvaluationInput
  paneAgentStates: WorkspaceCleanupPaneAgentStates
  removing: boolean
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

/** This host's own window persists its unsaved drafts in the session; remote clients report theirs. Keyed by identity so path spellings match. */
function dirtyEditorWorktreeIds(store: RuntimeStore, runtime: OrcaRuntimeService): Set<string> {
  const session = store.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
  const ids = new Set([...listClientUnsavedEditorWorktreeIds(runtime)].map(worktreeIdentityKey))
  for (const [worktreeId, files] of Object.entries(session?.openFilesByWorktree ?? {})) {
    if (files.some((file) => file.dirtyDraftContent !== undefined)) {
      ids.add(worktreeIdentityKey(worktreeId))
    }
  }
  return ids
}

async function scanTargets(
  store: RuntimeStore,
  runtime: OrcaRuntimeService,
  worktreeIds: string[],
  signal: AbortSignal | undefined,
  inventorySize?: number,
  requireComplete = false
): Promise<Map<string, WorkspaceCleanupCandidate>> {
  const candidates = new Map<string, WorkspaceCleanupCandidate>()
  if (worktreeIds.length === 0) {
    return candidates
  }
  const result = await scanWorkspaceCleanup(
    store,
    { refreshActivity: true },
    {
      signal,
      targetWorktreeIds: worktreeIds,
      // Large real Git inventories can exceed the normal interactive 8-second listing budget.
      listingTimeoutMs: inventorySize ? Math.min(60_000, 8_000 + inventorySize * 40) : undefined,
      getOrchestrationDb: () => runtime.getExistingOrchestrationDb()
    }
  )
  if (requireComplete && result.errors.length) {
    throw new Error(result.errors[0].message)
  }
  const failedRepos = new Set(result.errors.map((error) => error.repoId))
  for (const candidate of result.candidates) {
    if (
      !failedRepos.has(candidate.repoId) &&
      normalizeExecutionHostId(candidate.executionHostId) === LOCAL_EXECUTION_HOST_ID
    ) {
      candidates.set(candidate.worktreeId, candidate)
    }
  }
  return candidates
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
  const folderSiblingsOf = await folderSiblingsByWorktree(
    store,
    ps.worktrees,
    readPairedFolderChildren
  )
  const owned = ps.worktrees.filter(
    (summary) =>
      isOwnedSummary(summary, repos) &&
      (!args.comparison?.state.repoId || summary.repoId === args.comparison.state.repoId)
  )
  const summaries =
    args.withFolderSiblings && worktreeId !== undefined
      ? folderGroupOf(owned, worktreeId, folderSiblingsOf)
      : owned
  const policies = new Map<string, ResolvedWorkspaceCleanupPolicy>()
  const nextPolicies = new Map<string, ResolvedWorkspaceCleanupPolicy>()
  const saved = new Map(args.comparison?.state.projects.map((row) => [row.id, row.policy]))
  for (const summary of summaries) {
    if (policies.has(summary.repoId)) {
      continue
    }
    const repo = repos.get(summary.repoId)!
    const policy = args.comparison ? saved.get(repo.id) : repo.workspaceCleanupPolicy
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
  const candidates = await scanTargets(
    store,
    runtime,
    gitTargets,
    signal,
    args.comparison ? ps.worktrees.length : undefined,
    args.requireComplete ?? Boolean(args.comparison)
  )
  const dirtyEditors = dirtyEditorWorktreeIds(store, runtime)
  const scanned = new Set(gitTargets)
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
      identity: summaryIdentity(summary),
      folderSiblings: folderSiblingsOf(summary),
      readPairedFolderChildren
    }
  })
}
