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
import {
  readPairedFolderChildren,
  type PairedFolderChildren
} from './workspace-cleanup-paired-folder-children'
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
  now: number,
  options?: { readPairedFolderChildren?: () => Promise<PairedFolderChildren> }
): Promise<WorkspaceCleanupEvaluation[]> {
  const verdicts: WorkspaceCleanupFolderVerdict[] = []
  for (const workspace of workspaces) {
    verdicts.push({
      identity: workspace.identity,
      folderSiblings: workspace.folderSiblings,
      evaluation: await decideWorkspaceCleanup(runtime, workspace, now)
    })
  }
  const evaluations = keepFolderWorkspaceSiblings(verdicts)
  const candidateLocalFolders = new Set<string>()
  for (let i = 0; i < workspaces.length; i++) {
    const folderKey = workspaces[i].localFolderKey
    if (folderKey && evaluations[i].action !== 'keep') {
      candidateLocalFolders.add(folderKey)
    }
  }
  if (candidateLocalFolders.size === 0 || workspaces.length === 0) {
    return evaluations
  }
  const readPaired = options?.readPairedFolderChildren ?? workspaces[0].readPairedFolderChildren
  const heldFolders = await workspaces[0].findPairedHeldFolders(candidateLocalFolders, readPaired)
  if (heldFolders.size === 0) {
    return evaluations
  }
  return evaluations.map((evaluation, index) => {
    const folderKey = workspaces[index].localFolderKey
    return evaluation.action !== 'keep' && folderKey && heldFolders.has(folderKey)
      ? { action: 'keep', cause: 'folder-workspace-sibling', reason: evaluation.reason }
      : evaluation
  })
}

function describeRemovalError(error: unknown): string {
  return errorMessage(error).split(/\r?\n/)[0] || 'Removal failed.'
}

export type RemovalOutcome = Pick<
  WorkspaceCleanupRunRow,
  'outcome' | 'reason' | 'keepCause' | 'waiting' | 'keptOnRecheck' | 'branchKept' | 'error'
>

export type CleanupRemovalTarget<TRef> = {
  workspace: WorkspaceCleanupWorkspace
  ref: TRef
  reason: NonNullable<WorkspaceCleanupRunRow['reason']>
}

async function deleteCheckedWorkspace(
  runtime: OrcaRuntimeService,
  workspace: WorkspaceCleanupWorkspace,
  recheck: Extract<WorkspaceCleanupEvaluation, { action: 'delete' | 'archive' }>,
  signal?: AbortSignal
): Promise<RemovalOutcome> {
  if (signal?.aborted) {
    return { outcome: 'failed', error: 'Cleanup stopped before removing this workspace.' }
  }
  const selector = selectorFor(workspace)
  try {
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

/** Re-checks independent workspaces one at a time and each local folder group once as a batch
 * (with a fresh paired-server read), then removes approved members through the lifecycle queue. */
export async function removeWorkspacesForCleanup<TRef>(args: {
  runtime: OrcaRuntimeService
  store: RuntimeStore
  globalRules: () => WorkspaceCleanupRules
  removals: readonly CleanupRemovalTarget<TRef>[]
  now: () => number
  signal?: AbortSignal
}): Promise<
  { ref: TRef; reason: NonNullable<WorkspaceCleanupRunRow['reason']>; outcome: RemovalOutcome }[]
> {
  const { runtime, store, removals, signal } = args
  const batches: { localFolderKey: string | null; targets: CleanupRemovalTarget<TRef>[] }[] = []
  const folderBatches = new Map<string, CleanupRemovalTarget<TRef>[]>()
  for (const entry of removals) {
    const folderKey = entry.workspace.localFolderKey
    if (folderKey) {
      let group = folderBatches.get(folderKey)
      if (!group) {
        group = []
        folderBatches.set(folderKey, group)
        batches.push({ localFolderKey: folderKey, targets: group })
      }
      group.push(entry)
    } else {
      batches.push({ localFolderKey: null, targets: [entry] })
    }
  }
  const results: {
    ref: TRef
    reason: NonNullable<WorkspaceCleanupRunRow['reason']>
    outcome: RemovalOutcome
  }[] = []
  for (const batch of batches) {
    if (signal?.aborted) {
      break
    }
    let fresh: WorkspaceCleanupWorkspace[]
    let evaluations: WorkspaceCleanupEvaluation[]
    try {
      const target = batch.targets[0].workspace
      fresh = await collectWorkspaceCleanupWorkspaces({
        store,
        runtime,
        globalRules: args.globalRules(),
        now: args.now(),
        ...(batch.localFolderKey
          ? { folderKey: batch.localFolderKey }
          : { worktreeId: target.ref.worktreeId, withFolderSiblings: false }),
        // Always re-read connected paired servers before removal so newly attached members hold the folder.
        readPairedFolderChildren: () => readPairedFolderChildren(runtime),
        signal
      })
      evaluations = await decideWorkspaceCleanups(runtime, fresh, args.now())
    } catch (error) {
      const failure = describeRemovalError(error)
      for (const { ref, reason } of batch.targets) {
        results.push({ ref, reason, outcome: { outcome: 'failed', error: failure } })
      }
      continue
    }
    const byId = new Map<string, WorkspaceCleanupEvaluation>()
    for (let i = 0; i < fresh.length; i++) {
      byId.set(fresh[i].ref.worktreeId, evaluations[i])
    }
    const allGoing =
      fresh.length > 0 &&
      evaluations.every((entry) => entry.action !== 'keep') &&
      batch.targets.every(({ workspace }) => {
        const entry = byId.get(workspace.ref.worktreeId)
        return entry !== undefined && entry.action !== 'keep'
      })
    if (!allGoing) {
      for (const { workspace, ref, reason } of batch.targets) {
        const entry = byId.get(workspace.ref.worktreeId)
        const outcome: RemovalOutcome = !entry
          ? { outcome: 'kept', keepCause: 'git-unknown', keptOnRecheck: true }
          : entry.action === 'keep'
            ? { ...keptRunOutcome(entry), keptOnRecheck: true }
            : { outcome: 'kept', keepCause: 'folder-workspace-sibling', keptOnRecheck: true }
        results.push({ ref, reason, outcome })
      }
      continue
    }
    for (const { workspace, ref, reason } of batch.targets) {
      if (signal?.aborted) {
        break
      }
      const entry = byId.get(workspace.ref.worktreeId)
      if (!entry || entry.action === 'keep') {
        results.push({
          ref,
          reason,
          outcome: { outcome: 'kept', keepCause: 'git-unknown', keptOnRecheck: true }
        })
        continue
      }
      const outcome = await deleteCheckedWorkspace(runtime, workspace, entry, signal)
      results.push({ ref, reason, outcome })
    }
  }
  return results
}
