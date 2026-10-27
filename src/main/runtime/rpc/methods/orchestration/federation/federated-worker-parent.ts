import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../../../../shared/workspace-scope'
import { assertCrossMachineLineageSupported } from '../../../../../../shared/worktree-runtime-capabilities'
import type { ParentWorktreeRef } from '../../../../../../shared/worktree/lineage-types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export async function resolveFederatedWorkerParent(
  args: {
    runtime: OrcaRuntimeService
    params: { from?: string }
    callerSession?: OrchestrationSessionCaller
  },
  capabilities: readonly string[] | undefined,
  serverName: string
): Promise<ParentWorktreeRef> {
  const {
    runtime,
    params: { from },
    callerSession
  } = args
  assertCrossMachineLineageSupported(capabilities, serverName)
  const parentId =
    callerSession?.workspaceId ?? (from ? (await runtime.showTerminal(from)).worktreeId : undefined)
  if (!parentId) {
    throw new OrchestrationError(
      'invalid_argument',
      'The coordinator workspace is unavailable. Choose an existing parent workspace and retry.'
    )
  }
  const parent = await runtime.showManagedWorktree(
    `id:${normalizeWorkspaceSessionKeyToWorkspaceId(parentId)}`
  )
  const instanceId = parent.instanceId ?? (parent.id.startsWith('folder:') ? parent.id : undefined)
  if (!instanceId) {
    throw new OrchestrationError(
      'invalid_argument',
      'The coordinator workspace has no identity. Refresh it and retry.'
    )
  }
  return { worktreeId: parent.id, instanceId, external: true }
}
