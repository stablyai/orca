import type { WorkspaceCleanupRunnerDeps } from './workspace-cleanup-runner'
import {
  captureWorkspaceCleanupPolicyState,
  type WorkspaceCleanupPolicyRead,
  type WorkspaceCleanupPolicyChange,
  type WorkspaceCleanupPolicyComparison
} from '../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { WORKSPACE_CLEANUP_WRITE_LEASE_MS } from './workspace-cleanup-policy-write'
import { readWorkspaceSpaceAnalysisSnapshot } from '../space-analysis/workspace-space-analysis-snapshot'
import { collectWorkspaceCleanupWorkspaces } from './workspace-cleanup-run-evidence'
import { mapWorkspaceCleanupWithConcurrency } from '../../ipc/workspace-cleanup/workspace-cleanup-scan-primitives'
import {
  readWorkspaceCleanupTerminalActivity,
  type WorkspaceCleanupTerminalActivity
} from './workspace-cleanup-terminal-activity'
import { decideWorkspaceCleanup } from './workspace-cleanup-removal-step'
import { workspaceCleanupRowDetails } from './workspace-cleanup-run-summary'

export function readWorkspaceCleanupPolicy(
  store: Pick<RuntimeStore, 'getSettings' | 'getRepos'>,
  repoId: string | null
): WorkspaceCleanupPolicyRead {
  return {
    state: captureWorkspaceCleanupPolicyState(store.getSettings(), store.getRepos(), repoId),
    expiresAt: Date.now() + WORKSPACE_CLEANUP_WRITE_LEASE_MS,
    protocol: 1
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
  signal: AbortSignal
): Promise<WorkspaceCleanupPolicyComparison> {
  const evaluatedAt = Date.now()
  const [workspaces, sizes] = await Promise.all([
    collectWorkspaceCleanupWorkspaces({
      store: deps.store,
      runtime: deps.runtime,
      globalRules: read.state.rules,
      now: evaluatedAt,
      comparison: { state: read.state, change },
      signal: signal
    }),
    readWorkspaceCleanupSizes(deps.historyDirectory)
  ])
  const pairs = await mapWorkspaceCleanupWithConcurrency(workspaces, 3, async (workspace) => {
    let terminal: Promise<WorkspaceCleanupTerminalActivity> | undefined
    const activity = () =>
      (terminal ??= readWorkspaceCleanupTerminalActivity(
        deps.runtime,
        workspace.ref.worktreeId,
        workspace.paneAgentStates
      ))
    const current = await decideWorkspaceCleanup(deps.runtime, workspace, evaluatedAt, activity)
    const next = await decideWorkspaceCleanup(
      deps.runtime,
      { ...workspace, policy: workspace.nextPolicy! },
      evaluatedAt,
      activity
    )
    const ref = {
      ...workspace.ref,
      ...workspaceCleanupRowDetails(workspace.input),
      sizeBytes: sizes.get(workspace.ref.worktreeId)
    }
    return { current: { ...ref, evaluation: current }, next: { ...ref, evaluation: next } }
  })
  return {
    read,
    current: { evaluatedAt, rows: pairs.map((row) => row.current) },
    next: { evaluatedAt, rows: pairs.map((row) => row.next) }
  }
}
