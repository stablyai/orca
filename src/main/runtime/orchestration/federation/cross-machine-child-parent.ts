import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationEntryCaller } from '../addressing/orchestration-caller-identity'
import { OrchestrationError } from '../orchestration-error'
import { readCallerStoreInstallationId } from '../../hosts/platform-probe/host-descriptor'
import { getCanonicalUserDataPath } from '../../../persistence/loading-store/user-data-path'
import type { CrossStoreParentRef } from '../../../../shared/worktree/lineage-types'
import { resolveDispatchCallerWorktreeId } from '../../rpc/methods/orchestration/orchestration-caller-workspace'

/**
 * `--on <server> --worktree new-child`: the server's new worktree nests under the coordinator's
 * workspace on this machine, by the same verified ref the CLI's caller auto-nest builds.
 */
export async function resolveCrossMachineChildParent(
  runtime: Pick<
    OrcaRuntimeService,
    | 'showTerminal'
    | 'getOrchestrationDispatchAuthority'
    | 'resolveCallerParentForAnotherStore'
    | 'getRuntimeId'
  >,
  from: string,
  callerSession: OrchestrationEntryCaller | undefined
): Promise<CrossStoreParentRef> {
  // Orchestration's caller authority picks the workspace; the shared builder verifies and names it.
  const callerId = await resolveDispatchCallerWorktreeId(runtime, from, callerSession)
  const resolved = await runtime.resolveCallerParentForAnotherStore(
    { envParentWorkspace: `id:${callerId}` },
    await readCallerStoreInstallationId(runtime.getRuntimeId(), getCanonicalUserDataPath())
  )
  if ('reason' in resolved) {
    throw new OrchestrationError(
      'invalid_argument',
      `--worktree new-child can't nest under this workspace: ${resolved.reason} Use --worktree new-top-level.`
    )
  }
  return resolved.parent
}
