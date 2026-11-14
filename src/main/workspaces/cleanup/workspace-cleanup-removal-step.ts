import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import {
  queueWorkspaceArchive,
  queueWorkspaceDelete
} from '../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'
import { getEffectiveHooks } from '../../workspace-hooks/hooks'
import { errorMessage } from '../../../shared/error-message'
import {
  evaluateWorkspaceCleanup,
  type WorkspaceCleanupEvaluation
} from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import type { WorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupRunRow } from '../../../shared/workspace-cleanup/workspace-cleanup-run'
import {
  collectWorkspaceCleanupWorkspaces,
  type WorkspaceCleanupWorkspace
} from './workspace-cleanup-run-evidence'
import { readWorkspaceCleanupTerminalActivity } from './workspace-cleanup-terminal-activity'
import { keptRunOutcome } from './workspace-cleanup-run-summary'

function selectorFor(workspace: WorkspaceCleanupWorkspace): string {
  return `id:${workspace.ref.worktreeId}`
}

/** The evaluator's verdict plus the checks only a live host can make; any doubt keeps the workspace. */
export async function decideWorkspaceCleanup(
  runtime: OrcaRuntimeService,
  workspace: WorkspaceCleanupWorkspace,
  now: number
): Promise<WorkspaceCleanupEvaluation> {
  if (workspace.removing) {
    return { action: 'keep', cause: 'removing' }
  }
  const evaluation = evaluateWorkspaceCleanup(workspace.input, workspace.policy, now)
  if (evaluation.action === 'keep') {
    return evaluation
  }
  const { reason } = evaluation
  // An unattended run never runs repo scripts nobody approved, and never skips the teardown they do.
  // The checkout's own orca.yaml can add one the repo root lacks.
  if (
    getEffectiveHooks(workspace.repo)?.scripts.archive ||
    getEffectiveHooks(workspace.repo, workspace.ref.path)?.scripts.archive
  ) {
    return { action: 'keep', cause: 'archive-script', reason }
  }
  const terminals = await readWorkspaceCleanupTerminalActivity(
    runtime,
    workspace.ref.worktreeId,
    workspace.paneAgentStates
  )
  if (terminals === 'idle') {
    return evaluation
  }
  // Probed only for a would-remove verdict; the evaluator still owns the cause and its priority.
  const blocker = terminals === 'running' ? 'running-terminal' : 'terminal-liveness-unknown'
  return evaluateWorkspaceCleanup(
    { ...workspace.input, blockers: [...workspace.input.blockers, blocker] },
    workspace.policy,
    now
  )
}

function describeRemovalError(error: unknown): string {
  return errorMessage(error).split(/\r?\n/)[0] || 'Removal failed.'
}

type RemovalOutcome = Pick<
  WorkspaceCleanupRunRow,
  'outcome' | 'reason' | 'keepCause' | 'waiting' | 'keptOnRecheck' | 'branchKept' | 'error'
>

/** Re-reads every piece of evidence right before removing one workspace; removal itself goes through the lifecycle queue. */
export async function removeWorkspaceForCleanup(args: {
  runtime: OrcaRuntimeService
  store: RuntimeStore
  globalRules: () => WorkspaceCleanupRules
  workspace: WorkspaceCleanupWorkspace
  now: () => number
  signal?: AbortSignal
}): Promise<RemovalOutcome> {
  const { runtime, store, workspace } = args
  const selector = selectorFor(workspace)
  try {
    // Earlier removals in this run took time: decide on what is true now, not what the scan saw.
    const [fresh] = await collectWorkspaceCleanupWorkspaces({
      store,
      runtime,
      globalRules: args.globalRules(),
      now: args.now(),
      worktreeId: workspace.ref.worktreeId,
      signal: args.signal
    })
    if (!fresh) {
      return { outcome: 'kept', keepCause: 'git-unknown', keptOnRecheck: true }
    }
    const recheck = await decideWorkspaceCleanup(runtime, fresh, args.now())
    if (recheck.action === 'keep') {
      return { ...keptRunOutcome(recheck), keptOnRecheck: true }
    }
    if (args.signal?.aborted) {
      return { outcome: 'failed', error: 'Cleanup stopped before removing this workspace.' }
    }
    // Only reachable once WORKSPACE_ARCHIVE_SUPPORTED is on; archive keeps the branch and the row.
    if (recheck.action === 'archive') {
      const hostId = workspace.ref.executionHostId
      const archived = await queueWorkspaceArchive(runtime, selector, hostId, () =>
        runtime.archiveManagedWorktree(selector, hostId ? { hostId } : {})
      )
      return { outcome: 'archived', reason: recheck.reason, branchKept: archived.branch }
    }
    // Never forced: Git's own dirty-checkout refusal stays the last guard.
    const result = await queueWorkspaceDelete(
      runtime,
      selector,
      workspace.ref.executionHostId,
      {},
      (removal) =>
        runtime.removeManagedWorktree(selector, { ...removal, waitForBackgroundRemoval: true })
    )
    return {
      outcome: 'removed',
      reason: recheck.reason,
      ...(result.preservedBranch ? { branchKept: result.preservedBranch.branchName } : {})
    }
  } catch (error) {
    return { outcome: 'failed', error: describeRemovalError(error) }
  }
}
