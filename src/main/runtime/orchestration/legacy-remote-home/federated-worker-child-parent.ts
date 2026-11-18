import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationEntryCaller } from '../addressing/orchestration-caller-identity'
import type { CrossStoreParentRef } from '../../../../shared/worktree/lineage-types'
import { supportsCrossStoreLineage } from '../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { resolveDispatchCallerWorktreeId } from '../../rpc/methods/orchestration/orchestration-caller-workspace'
import { resolveCrossMachineChildParent } from '../federation/cross-machine-child-parent'

/** An attached server's new-child; one without cross-machine parents still gets the worker, top-level with a warning. */
export async function resolveFederatedChildParent(args: {
  runtime: Pick<
    OrcaRuntimeService,
    | 'showTerminal'
    | 'getOrchestrationDispatchAuthority'
    | 'showManagedWorktree'
    | 'resolveCallerParentForAnotherStore'
    | 'getRuntimeId'
  >
  from: string
  callerSession: OrchestrationEntryCaller | undefined
  serverCapabilities: readonly string[] | undefined
  serverName: string
}): Promise<
  | { crossStoreParent: CrossStoreParentRef; crossStoreParentInferredFrom: 'orchestration-context' }
  | { warning: string }
> {
  const { runtime } = args
  if (!supportsCrossStoreLineage(args.serverCapabilities)) {
    const callerId = await resolveDispatchCallerWorktreeId(runtime, args.from, args.callerSession)
    const name = await runtime
      .showManagedWorktree(`id:${callerId}`)
      .then((worktree) => worktree.displayName || worktree.id)
      .catch(() => callerId)
    return {
      warning: `Not nested under ${name}: ${args.serverName} needs an Orca update to nest across machines, so the worktree was created top-level.`
    }
  }
  return {
    crossStoreParent: await resolveCrossMachineChildParent(runtime, args.from, args.callerSession),
    crossStoreParentInferredFrom: 'orchestration-context'
  }
}
