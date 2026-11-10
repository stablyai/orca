import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationSessionCaller } from '../addressing/orchestration-caller-identity'
import { OrchestrationError } from '../orchestration-error'
import { readCallerStoreInstallationId } from '../../hosts/platform-probe/host-descriptor'
import { getCanonicalUserDataPath } from '../../../persistence/loading-store/user-data-path'
import type { CrossStoreParentRef } from '../../../../shared/worktree/lineage-types'
import { supportsCrossStoreLineage } from '../../../../shared/worktree-runtime-capabilities'
import { resolveDispatchCallerWorktreeId } from '../../rpc/methods/orchestration/orchestration-caller-workspace'

/**
 * `--on <server> --worktree new-child`: the server's new worktree nests under the coordinator's
 * workspace on this machine, by the same verified ref the CLI's caller auto-nest builds. A server
 * without cross-machine parents still gets the worker, as a top-level worktree with a warning.
 */
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
  callerSession: OrchestrationSessionCaller | undefined
  serverCapabilities: readonly string[] | undefined
  serverName: string
}): Promise<
  | { crossStoreParent: CrossStoreParentRef; crossStoreParentInferredFrom: 'orchestration-context' }
  | { warning: string }
> {
  const { runtime } = args
  // Orchestration's caller authority picks the workspace; the shared builder verifies and names it.
  const callerId = await resolveDispatchCallerWorktreeId(runtime, args.from, args.callerSession)
  if (!supportsCrossStoreLineage(args.serverCapabilities)) {
    const name = await runtime
      .showManagedWorktree(`id:${callerId}`)
      .then((worktree) => worktree.displayName || worktree.id)
      .catch(() => callerId)
    return {
      warning: `Not nested under ${name}: ${args.serverName} needs an Orca update to nest across machines, so the worktree was created top-level.`
    }
  }
  const resolved = await runtime.resolveCallerParentForAnotherStore(
    { envParentWorkspace: `id:${callerId}` },
    readCallerStoreInstallationId(runtime.getRuntimeId(), getCanonicalUserDataPath())
  )
  if ('reason' in resolved) {
    throw new OrchestrationError(
      'invalid_argument',
      `--worktree new-child can't nest under this workspace: ${resolved.reason} Use --worktree new-top-level.`
    )
  }
  return {
    crossStoreParent: resolved.parent,
    crossStoreParentInferredFrom: 'orchestration-context'
  }
}
