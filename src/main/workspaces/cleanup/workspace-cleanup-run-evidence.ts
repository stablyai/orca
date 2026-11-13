import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import { listClientUnsavedEditorWorktreeIds } from './workspace-cleanup-client-unsaved-editors'
import { runtimeVisibleRepos } from '../../runtime/workspaces/catalog/runtime-visible-catalog'
import { scanWorkspaceCleanup } from '../../ipc/workspace-cleanup/workspace-cleanup-scan'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import {
  isRepoOnCatalogHost,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../shared/execution-host'
import type { RuntimeWorktreePsSummary } from '../../../shared/runtime-worktree-contracts'
import {
  getPersistedWorkspaceCleanupActivityAt,
  WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT,
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
  input: WorkspaceCleanupEvaluationInput
  paneAgentStates: WorkspaceCleanupPaneAgentStates
  removing: boolean
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
  const hostId = summary.hostId ? normalizeExecutionHostId(summary.hostId) : LOCAL_EXECUTION_HOST_ID
  return (
    repos.has(summary.repoId) &&
    hostId === LOCAL_EXECUTION_HOST_ID &&
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
  signal: AbortSignal | undefined
): Promise<Map<string, WorkspaceCleanupCandidate>> {
  const candidates = new Map<string, WorkspaceCleanupCandidate>()
  for (let start = 0; start < worktreeIds.length; start += WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT) {
    const batch = worktreeIds.slice(start, start + WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
    // Re-stat activity: a time rule must not fire on a stale persisted stamp.
    const result = await scanWorkspaceCleanup(
      store,
      { worktreeIds: batch, refreshActivity: true },
      // Without the orchestration store the scan can't prove a worker was released.
      { signal, getOrchestrationDb: () => runtime.getExistingOrchestrationDb() }
    )
    for (const candidate of result.candidates) {
      // A same-id repo row on another host scans too; only this host's checkout is evidence here.
      if (normalizeExecutionHostId(candidate.executionHostId) === LOCAL_EXECUTION_HOST_ID) {
        candidates.set(candidate.worktreeId, candidate)
      }
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

/** Every workspace this process owns, with the evidence the evaluator reads; one id narrows it for a re-check. */
export async function collectWorkspaceCleanupWorkspaces(args: {
  store: RuntimeStore
  runtime: OrcaRuntimeService
  globalRules: WorkspaceCleanupRules
  now: number
  worktreeId?: string
  signal?: AbortSignal
}): Promise<WorkspaceCleanupWorkspace[]> {
  const { store, runtime, globalRules, now, worktreeId, signal } = args
  const repos = listWorkspaceCleanupOwnedRepos(store)
  const ps = await runtime.getWorktreePs(WORKTREE_PS_LIMIT)
  if (ps.truncated) {
    throw new Error('Could not list every workspace on this host.')
  }
  const summaries = ps.worktrees.filter(
    (summary) =>
      isOwnedSummary(summary, repos) &&
      (worktreeId === undefined || summary.worktreeId === worktreeId)
  )
  const policies = new Map<string, ResolvedWorkspaceCleanupPolicy>()
  for (const repo of repos.values()) {
    policies.set(
      repo.id,
      resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: globalRules }, repo)
    )
  }
  const gitTargets = summaries
    .filter((summary) => {
      const rules = policies.get(summary.repoId)!.rules
      return needsGitEvidence(summary, rules, now)
    })
    .map((summary) => summary.worktreeId)
  const candidates = await scanTargets(store, runtime, gitTargets, signal)
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
        ...(candidate?.executionHostId ? { executionHostId: candidate.executionHostId } : {}),
        repoId: repo.id,
        repoName: repo.displayName,
        displayName: summary.displayName,
        branch: shortWorkspaceCleanupBranchName(summary.branch),
        path: summary.path
      },
      repo,
      policy: policies.get(summary.repoId)!,
      input: withHostBlockers(
        baseInput,
        summary,
        agentLive,
        dirtyEditors.has(worktreeIdentityKey(summary.worktreeId))
      ),
      paneAgentStates,
      removing: summary.removing === true
    }
  })
}
