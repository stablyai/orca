import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { CrossStoreParentRef } from '../../../../../../shared/worktree/lineage-types'
import { supportsCrossStoreLineage } from '../../../../../../shared/worktree-runtime-capabilities'
import { resolveDispatchCallerWorktreeId } from '../../orchestration-caller-workspace'

/**
 * `--on <server> --worktree new-child`: the server's new worktree nests under the coordinator's
 * workspace on this machine, by the same verified ref the CLI's caller auto-nest sends. A server
 * without cross-machine parents still gets the worker, as a top-level worktree with a warning.
 */
export async function resolveFederatedChildParent(args: {
  runtime: Pick<
    OrcaRuntimeService,
    | 'showTerminal'
    | 'getOrchestrationDispatchAuthority'
    | 'showManagedWorktree'
    | 'readStoreInstallationId'
  >
  from: string
  callerSession: OrchestrationSessionCaller | undefined
  serverCapabilities: readonly string[] | undefined
  serverName: string
}): Promise<{ crossStoreParent: CrossStoreParentRef } | { warning: string }> {
  const { runtime } = args
  const callerId = await resolveDispatchCallerWorktreeId(runtime, args.from, args.callerSession)
  if (isWorkspaceKey(callerId)) {
    throw new OrchestrationError(
      'invalid_argument',
      "A folder workspace can't parent a worktree on another machine yet; use --worktree new-top-level."
    )
  }
  const caller = await runtime.showManagedWorktree(`id:${callerId}`).catch(() => {
    throw new OrchestrationError(
      'invalid_argument',
      "The dispatching terminal's workspace could not be resolved to a git worktree Orca manages, which --worktree new-child needs; run from one, or pass --worktree new-top-level."
    )
  })
  if (!supportsCrossStoreLineage(args.serverCapabilities)) {
    return {
      warning: `Not nested under ${caller.displayName || caller.id}: ${args.serverName} needs an Orca update to nest across machines, so the worktree was created top-level.`
    }
  }
  const installationId = await runtime.readStoreInstallationId()
  if (!installationId || !caller.instanceId) {
    throw new OrchestrationError(
      'invalid_argument',
      "Couldn't confirm this workspace's machine or identity for new-child; use --worktree new-top-level."
    )
  }
  return {
    crossStoreParent: {
      installationId,
      workspaceKey: worktreeWorkspaceKey(caller.id),
      instanceId: caller.instanceId
    }
  }
}
