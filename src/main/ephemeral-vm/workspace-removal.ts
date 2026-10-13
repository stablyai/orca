import { getEphemeralVmRecipeResultCheckoutMode } from '../../shared/ephemeral-vm-recipes'
import { z } from 'zod'
import type { WorktreeRemove } from '../../shared/rpc-contract/worktree-params'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { findEphemeralVmWorkspaceOwner } from '../../shared/ephemeral-vm-workspace-owner'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

export type RecipeWorkspaceRemoveParams = z.infer<typeof WorktreeRemove>
const Removed = z
  .object({ removed: z.literal(true), removing: z.boolean().optional() })
  .passthrough()

export function ownsRecipeWorkspaceRemoval(
  userDataPath: string,
  params: RecipeWorkspaceRemoveParams
): boolean {
  return Boolean(
    params.hostId &&
    params.worktree.startsWith('id:') &&
    findEphemeralVmWorkspaceOwner(
      listEphemeralVmRuntimes(userDataPath),
      params.worktree.slice(3),
      params.hostId
    )
  )
}

/** The provisioning host runs destroy; the checkout host still owns Git and process teardown. */
export async function removeRecipeWorkspace(
  userDataPath: string,
  params: RecipeWorkspaceRemoveParams,
  ports: {
    call: (
      environmentId: string,
      method: string,
      params: unknown
    ) => Promise<RuntimeRpcResponse<unknown>>
    cleanup: (runtimeId: string) => Promise<{ status: string; cleanupLastError?: string }>
  }
): Promise<{ removed: true }> {
  const runtime =
    params.hostId &&
    findEphemeralVmWorkspaceOwner(
      listEphemeralVmRuntimes(userDataPath),
      params.worktree.slice(3),
      params.hostId
    )
  if (!runtime) {
    throw new Error('Recipe workspace ownership changed. Refresh and try again.')
  }
  if (!runtime.runtimeEnvironmentId) {
    throw new Error('This recipe workspace has no serving Orca host. Reconnect it before removal.')
  }
  // A provisioned root is the VM's primary checkout, protected from ordinary Git deletion.
  if (
    getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult) !== 'provisioned-root' &&
    runtime.status !== 'cleaned'
  ) {
    const response = await ports.call(runtime.runtimeEnvironmentId, 'worktree.rm', {
      ...params,
      hostId: 'local'
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const removed = Removed.parse(response.result)
    if (removed.removing) {
      throw new Error(
        'The checkout is still being removed. Retry after removal finishes to destroy its environment.'
      )
    }
  }
  const cleaned = await ports.cleanup(runtime.id)
  if (cleaned.status !== 'cleaned') {
    throw new Error(
      cleaned.cleanupLastError ?? 'Environment destroy failed. Retry removal to finish cleanup.'
    )
  }
  return { removed: true }
}
