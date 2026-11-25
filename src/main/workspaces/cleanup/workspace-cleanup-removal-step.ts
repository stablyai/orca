import {
  captureWorkspaceCleanupPolicyAuthority,
  type WorkspaceCleanupPolicyAuthority
} from './workspace-cleanup-policy-durability'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import {
  queueWorkspaceArchive,
  queueWorkspaceDelete
} from '../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'
import { getEffectiveHooksAsync } from '../../workspace-hooks/effective-hooks-reader'
import { errorMessage } from '../../../shared/errors/error-message'
import { isWorktreeIdentityUnverifiable } from '../../../shared/worktree/removal/worktree-checkout-identity'
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
  type WorkspaceCleanupTerminalActivity,
  readWorkspaceCleanupTerminalActivity
} from './workspace-cleanup-terminal-activity'
import { keptRunOutcome } from './workspace-cleanup-run-summary'
import { admitWorkspaceCleanup } from './workspace-cleanup-admission'

function selectorFor(workspace: WorkspaceCleanupWorkspace): string {
  return `id:${workspace.ref.worktreeId}`
}

/** The evaluator's verdict plus the checks only a live host can make; any doubt keeps the workspace.
 * One workspace alone: a folder workspace's group hold is `keepFolderWorkspaceSiblings`' job. */
export async function decideWorkspaceCleanup(
  runtime: OrcaRuntimeService,
  workspace: WorkspaceCleanupWorkspace,
  now: number,
  terminalActivity?: () => Promise<WorkspaceCleanupTerminalActivity>,
  readHooks: typeof getEffectiveHooksAsync = getEffectiveHooksAsync
): Promise<WorkspaceCleanupEvaluation> {
  if (workspace.removing) {
    return { action: 'keep', cause: 'removing' }
  }
  const evaluation = evaluateWorkspaceCleanup(workspace.input, workspace.policy, now)
  if (evaluation.action === 'keep') {
    return evaluation
  }
  const { reason } = evaluation
  // The removal would refuse this route; the preview and the run say so instead of listing a deletion.
  if (workspace.removalRouteUnverifiable) {
    return { action: 'keep', cause: 'identity-unverified', reason }
  }
  // An unattended run never runs repo scripts nobody approved, and never skips the teardown they do.
  // The checkout's own orca.yaml can add one the repo root lacks.
  if (
    (await readHooks(workspace.repo))?.scripts.archive ||
    (await readHooks(workspace.repo, workspace.ref.path))?.scripts.archive
  ) {
    return { action: 'keep', cause: 'archive-script', reason }
  }
  const terminals = await (terminalActivity
    ? terminalActivity()
    : readWorkspaceCleanupTerminalActivity(
        runtime,
        workspace.ref.worktreeId,
        workspace.paneAgentStates
      ))
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
      identity: workspace.identity,
      folderSiblings: workspace.folderSiblings,
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

/** Re-reads every piece of evidence, its folder siblings' too, right before removing one workspace;
 * removal itself goes through the lifecycle queue. */
type RemovalArgs = {
  runtime: OrcaRuntimeService
  store: RuntimeStore
  globalRules: () => WorkspaceCleanupRules
  workspace: WorkspaceCleanupWorkspace
  now: () => number
  signal?: AbortSignal
}
const RULES_CHANGED = Symbol('rules-changed')

export async function removeWorkspaceForCleanup(args: RemovalArgs): Promise<RemovalOutcome> {
  // Rules written while deciding didn't authorize the decision: decide again under the new ones.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await removeUnderRules(args, await captureWorkspaceCleanupPolicyAuthority())
    if (outcome !== RULES_CHANGED) {
      return outcome
    }
  }
  return { outcome: 'kept', keepCause: 'identity-unverified', keptOnRecheck: true }
}

async function removeUnderRules(
  args: RemovalArgs,
  rules: WorkspaceCleanupPolicyAuthority
): Promise<RemovalOutcome | typeof RULES_CHANGED> {
  const { runtime, store, workspace } = args
  const selector = selectorFor(workspace)
  try {
    // Earlier removals in this run took time: decide on what is true now, not what the scan saw.
    // A folder member is re-read with its folder as listed now: a sibling added here since holds it
    // too. Paired servers' members are as the scan read them; they're asked once per run.
    const [fresh, ...siblings] = await collectWorkspaceCleanupWorkspaces({
      store,
      runtime,
      globalRules: args.globalRules(),
      now: args.now(),
      worktreeId: workspace.ref.worktreeId,
      withFolderSiblings: workspace.folderSiblings.length > 0,
      readPairedFolderChildren: workspace.readPairedFolderChildren,
      captureCheckoutIdentity: true,
      signal: args.signal
    })
    if (!fresh) {
      return { outcome: 'kept', keepCause: 'git-unknown', keptOnRecheck: true }
    }
    // Another workspace now has this id, or the scan could not tell which one it judged: keep it this run.
    if (!workspace.ref.instanceId || fresh.ref.instanceId !== workspace.ref.instanceId) {
      return { outcome: 'kept', keepCause: 'identity-unverified', keptOnRecheck: true }
    }
    const [recheck] = await decideWorkspaceCleanups(runtime, [fresh, ...siblings], args.now())
    if (recheck.action === 'keep') {
      return { ...keptRunOutcome(recheck), keptOnRecheck: true }
    }
    if (args.signal?.aborted) {
      return { outcome: 'failed', error: 'Cleanup stopped before removing this workspace.' }
    }
    // Only reachable once WORKSPACE_ARCHIVE_SUPPORTED is on; archive keeps the branch and the row.
    if (recheck.action === 'archive') {
      const hostId = workspace.ref.executionHostId
      const admission = await admitWorkspaceCleanup(
        store,
        fresh.ref,
        () =>
          queueWorkspaceArchive(
            runtime,
            selector,
            hostId,
            () =>
              runtime.archiveManagedWorktree(selector, {
                ...(hostId ? { hostId } : {}),
                expectedWorktree: {
                  worktreeId: fresh.ref.worktreeId,
                  instanceId: fresh.ref.instanceId!,
                  checkoutIdentity: fresh.checkoutIdentity
                }
              }),
            {
              worktreeId: fresh.ref.worktreeId,
              instanceId: fresh.ref.instanceId!,
              checkoutIdentity: fresh.checkoutIdentity
            }
          ),
        rules
      )
      if (!admission.admitted) {
        return admission.cause === 'rules-changed'
          ? RULES_CHANGED
          : { outcome: 'kept', keepCause: admission.cause, keptOnRecheck: true }
      }
      const archived = await admission.completion
      return { outcome: 'archived', reason: recheck.reason, branchKept: archived.branch }
    }
    // Never forced: Git's own dirty-checkout refusal stays the last guard.
    const admission = await admitWorkspaceCleanup(
      store,
      fresh.ref,
      () =>
        queueWorkspaceDelete(
          runtime,
          selector,
          workspace.ref.executionHostId,
          {
            expectedWorktree: {
              worktreeId: fresh.ref.worktreeId,
              instanceId: fresh.ref.instanceId!,
              checkoutIdentity: fresh.checkoutIdentity
            }
          },
          (removal) =>
            runtime.removeManagedWorktree(selector, { ...removal, waitForBackgroundRemoval: true })
        ),
      rules
    )
    if (!admission.admitted) {
      return admission.cause === 'rules-changed'
        ? RULES_CHANGED
        : { outcome: 'kept', keepCause: admission.cause, keptOnRecheck: true }
    }
    const result = await admission.completion
    return {
      outcome: 'removed',
      reason: recheck.reason,
      ...(result.preservedBranch ? { branchKept: result.preservedBranch.branchName } : {})
    }
  } catch (error) {
    // Where Orca can't check the checkout's identity right before Git deletes it (WSL), it keeps it.
    if (isWorktreeIdentityUnverifiable(error)) {
      return { outcome: 'kept', keepCause: 'identity-unverified', keptOnRecheck: true }
    }
    return { outcome: 'failed', error: describeRemovalError(error) }
  }
}
