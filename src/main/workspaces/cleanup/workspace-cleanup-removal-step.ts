import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import {
  queueWorkspaceArchive,
  queueWorkspaceDelete
} from '../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'
import { getEffectiveHooks } from '../../workspace-hooks/hooks'
import { errorMessage } from '../../../shared/errors/error-message'
import {
  evaluateWorkspaceCleanup,
  keepFolderWorkspaceSiblings,
  type WorkspaceCleanupEvaluation,
  type WorkspaceCleanupFolderVerdict
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
async function decideWorkspaceCleanup(
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

/** Every workspace's verdict, in order; a folder workspace's worktrees go together or not at all. */
export async function decideWorkspaceCleanups(
  runtime: OrcaRuntimeService,
  workspaces: readonly WorkspaceCleanupWorkspace[],
  now: number
): Promise<WorkspaceCleanupEvaluation[]> {
  const verdicts: WorkspaceCleanupFolderVerdict[] = []
  for (const workspace of workspaces) {
    verdicts.push({
      worktreeId: workspace.ref.worktreeId,
      folderSiblingIds: workspace.folderSiblingIds,
      evaluation: await decideWorkspaceCleanup(runtime, workspace, now)
    })
  }
  return keepFolderWorkspaceSiblings(verdicts)
}

function describeRemovalError(error: unknown): string {
  return errorMessage(error).split(/\r?\n/)[0] || 'Removal failed.'
}

type RemovalOutcome = Pick<
  WorkspaceCleanupRunRow,
  'outcome' | 'reason' | 'keepCause' | 'waiting' | 'keptOnRecheck' | 'branchKept' | 'error'
>

type RemovalArgs = {
  runtime: OrcaRuntimeService
  store: RuntimeStore
  globalRules: () => WorkspaceCleanupRules
  workspace: WorkspaceCleanupWorkspace
  now: () => number
  signal?: AbortSignal
}

/** The workspace, then the folder siblings the scan saw that are still listed. One no longer listed
 * was removed since: the scan already kept every group with a sibling this host could not judge. */
async function recollectWorkspaceCleanupGroup(
  args: RemovalArgs
): Promise<WorkspaceCleanupWorkspace[]> {
  const group: WorkspaceCleanupWorkspace[] = []
  for (const worktreeId of [args.workspace.ref.worktreeId, ...args.workspace.folderSiblingIds]) {
    const [row] = await collectWorkspaceCleanupWorkspaces({
      store: args.store,
      runtime: args.runtime,
      globalRules: args.globalRules(),
      now: args.now(),
      worktreeId,
      signal: args.signal
    })
    if (row) {
      group.push(row)
    } else if (group.length === 0) {
      return []
    }
  }
  return group
}

/** Re-reads every piece of evidence, its folder siblings' too, right before removing one workspace;
 * removal itself goes through the lifecycle queue. */
export async function removeWorkspaceForCleanup(args: RemovalArgs): Promise<RemovalOutcome> {
  const { runtime, workspace } = args
  const selector = selectorFor(workspace)
  try {
    // Earlier removals in this run took time: decide on what is true now, not what the scan saw.
    const [fresh, ...siblings] = await recollectWorkspaceCleanupGroup(args)
    if (!fresh) {
      return { outcome: 'kept', keepCause: 'git-unknown', keptOnRecheck: true }
    }
    const [recheck] = await decideWorkspaceCleanups(
      runtime,
      [
        { ...fresh, folderSiblingIds: siblings.map((sibling) => sibling.ref.worktreeId) },
        ...siblings
      ],
      args.now()
    )
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
