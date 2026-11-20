import type { WorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPreview } from '../../../shared/workspace-cleanup/workspace-cleanup-run'
import type { WorkspaceCleanupRunnerDeps } from './workspace-cleanup-runner'
import {
  captureWorkspaceCleanupPolicyState,
  type WorkspaceCleanupPolicyRead,
  type WorkspaceCleanupPolicyChange,
  type WorkspaceCleanupPolicyComparison
} from '../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import {
  hasPendingWorkspaceCleanupWrites,
  WORKSPACE_CLEANUP_WRITE_LEASE_MS
} from './workspace-cleanup-policy-write'
import { readWorkspaceSpaceAnalysisSnapshot } from '../space-analysis/workspace-space-analysis-snapshot'
import { collectWorkspaceCleanupWorkspaces } from './workspace-cleanup-run-evidence'
import { mapWorkspaceCleanupWithConcurrency } from '../../ipc/workspace-cleanup/workspace-cleanup-scan-primitives'
import {
  readWorkspaceCleanupTerminalActivity,
  type WorkspaceCleanupTerminalActivity
} from './workspace-cleanup-terminal-activity'
import { decideWorkspaceCleanup } from './workspace-cleanup-removal-step'
import { keepFolderWorkspaceSiblings } from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { workspaceCleanupRowDetails } from './workspace-cleanup-run-summary'
import { createEffectiveHooksReader } from '../../workspace-hooks/effective-hooks-reader'

export function readWorkspaceCleanupPolicy(
  store: Pick<RuntimeStore, 'getSettings' | 'getRepos' | 'getProfileStorageDirectory'>,
  repoId: string | null
): WorkspaceCleanupPolicyRead {
  return {
    state: captureWorkspaceCleanupPolicyState(store.getSettings(), store.getRepos(), repoId),
    expiresAt: Date.now() + WORKSPACE_CLEANUP_WRITE_LEASE_MS,
    protocol: 3,
    pendingWrites: hasPendingWorkspaceCleanupWrites(store)
  }
}
export async function readWorkspaceCleanupSizes(directory: string): Promise<Map<string, number>> {
  const analysis = await readWorkspaceSpaceAnalysisSnapshot(directory)
  const sizes = new Map<string, number>()
  for (const row of analysis?.worktrees ?? []) {
    if (row.status === 'ok') {
      sizes.set(row.worktreeId, row.sizeBytes)
    }
  }
  return sizes
}
export async function previewWorkspaceCleanupChange(
  deps: WorkspaceCleanupRunnerDeps,
  change: WorkspaceCleanupPolicyChange,
  read: WorkspaceCleanupPolicyRead,
  signal: AbortSignal,
  freshInventory = false
): Promise<WorkspaceCleanupPolicyComparison> {
  const evaluatedAt = Date.now()
  const [workspaces, sizes] = await Promise.all([
    collectWorkspaceCleanupWorkspaces({
      store: deps.store,
      runtime: deps.runtime,
      globalRules: read.state.rules,
      now: evaluatedAt,
      comparison: { state: read.state, change },
      freshInventory,
      signal: signal
    }),
    readWorkspaceCleanupSizes(deps.historyDirectory)
  ])
  const readHooks = createEffectiveHooksReader()
  const pairs = await mapWorkspaceCleanupWithConcurrency(workspaces, 3, async (workspace) => {
    let terminal: Promise<WorkspaceCleanupTerminalActivity> | undefined
    const activity = () =>
      (terminal ??= readWorkspaceCleanupTerminalActivity(
        deps.runtime,
        workspace.ref.worktreeId,
        workspace.paneAgentStates
      ))
    const current = await decideWorkspaceCleanup(
      deps.runtime,
      workspace,
      evaluatedAt,
      activity,
      readHooks
    )
    const next = await decideWorkspaceCleanup(
      deps.runtime,
      { ...workspace, policy: workspace.nextPolicy! },
      evaluatedAt,
      activity,
      readHooks
    )
    const ref = {
      ...workspace.ref,
      ...workspaceCleanupRowDetails(workspace.input),
      sizeBytes: sizes.get(workspace.ref.worktreeId)
    }
    return { current: { ...ref, evaluation: current }, next: { ...ref, evaluation: next } }
  })
  // A run takes a folder workspace's worktrees together or not at all; so does what it shows.
  const grouped = (side: 'current' | 'next') => {
    const evaluations = keepFolderWorkspaceSiblings(
      workspaces.map((workspace, index) => ({
        identity: workspace.identity,
        folderSiblings: workspace.folderSiblings,
        evaluation: pairs[index][side].evaluation
      }))
    )
    return pairs.map((pair, index) => ({ ...pair[side], evaluation: evaluations[index] }))
  }
  return {
    read,
    current: { evaluatedAt, rows: grouped('current') },
    next: { evaluatedAt, rows: grouped('next') }
  }
}

export class WorkspaceCleanupChangePreviews {
  private readonly currentPreviews = new Map<string, Promise<WorkspaceCleanupPreview>>()
  current(
    rules: WorkspaceCleanupRules,
    evaluate: () => Promise<WorkspaceCleanupPreview>
  ): Promise<WorkspaceCleanupPreview> {
    const key = JSON.stringify(rules)
    const shared = this.currentPreviews.get(key)
    if (shared) {
      return shared
    }
    const evaluation = evaluate()
    this.currentPreviews.set(key, evaluation)
    void evaluation
      .catch(() => undefined)
      .finally(() => {
        if (this.currentPreviews.get(key) === evaluation) {
          this.currentPreviews.delete(key)
        }
      })
    return evaluation
  }

  private readonly pending = new Map<string, Promise<WorkspaceCleanupPolicyComparison>>()
  constructor(
    private readonly deps: WorkspaceCleanupRunnerDeps,
    private readonly signal: AbortSignal
  ) {}
  preview(
    change: WorkspaceCleanupPolicyChange,
    expected: WorkspaceCleanupPolicyRead['state'],
    fresh = false
  ): Promise<WorkspaceCleanupPolicyComparison> {
    const proposal = structuredClone(change)
    const read = readWorkspaceCleanupPolicy(
      this.deps.store,
      proposal.scope === 'project' ? proposal.repoId : null
    )
    if (JSON.stringify(read.state) !== JSON.stringify(expected)) {
      throw new Error('workspace_cleanup_policy_conflict')
    }
    const key = JSON.stringify([read.state, proposal])
    const existing = fresh ? undefined : this.pending.get(key)
    if (existing) {
      return existing
    }
    const request = previewWorkspaceCleanupChange(
      this.deps,
      proposal,
      read,
      this.signal,
      fresh
    ).finally(() => {
      if (this.pending.get(key) === request) {
        this.pending.delete(key)
      }
    })
    if (!fresh) {
      this.pending.set(key, request)
    }
    return request
  }
}
