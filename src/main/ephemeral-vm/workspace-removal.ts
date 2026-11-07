import { getEphemeralVmRecipeResultCheckoutMode } from '../../shared/ephemeral-vm-recipes'
import { z } from 'zod'
import type { WorktreeRemove } from '../../shared/rpc-contract/worktree-params'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { findEphemeralVmWorkspaceOwner } from '../../shared/ephemeral-vm-workspace-owner'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

export type RecipeWorkspaceRemoveParams = z.infer<typeof WorktreeRemove>
// An accepted background removal answers { removed: false, removing: true }.
const Removed = z
  .object({ removed: z.boolean().optional(), removing: z.boolean().optional() })
  .passthrough()

function findRecipeRemovalOwner(userDataPath: string, params: RecipeWorkspaceRemoveParams) {
  if (!params.hostId || !params.worktree.startsWith('id:')) {
    return undefined
  }
  const owner = findEphemeralVmWorkspaceOwner(
    listEphemeralVmRuntimes(userDataPath),
    params.worktree.slice(3),
    params.hostId
  )
  // Without a serving Orca host there is nobody to ask for Git removal; SSH-only workspaces keep the ordinary path.
  return owner?.runtimeEnvironmentId ? owner : undefined
}

export function ownsRecipeWorkspaceRemoval(
  userDataPath: string,
  params: RecipeWorkspaceRemoveParams
): boolean {
  return findRecipeRemovalOwner(userDataPath, params) !== undefined
}

function isProvisionedRoot(runtime: EphemeralVmRuntimeRecord): boolean {
  return getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult) === 'provisioned-root'
}

/** A provisioned root skips Git, so removing it destroys the VM outright; require explicit confirmation. */
export function assertRecipeRemovalConfirmed(
  userDataPath: string,
  params: RecipeWorkspaceRemoveParams
): void {
  const runtime = findRecipeRemovalOwner(userDataPath, params)
  if (!runtime || !isProvisionedRoot(runtime) || runtime.status === 'cleaned') {
    return
  }
  if (params.force !== true) {
    throw new Error(
      `Removing this workspace destroys its environment VM "${runtime.workspaceName ?? runtime.id}" (recipe ${runtime.recipeId}), discarding uncommitted work and live terminals. Pass --force to confirm.`
    )
  }
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
  },
  /** Orders the destroy behind the workspace's in-flight VM wake or suspend. */
  orderDestroy: <T>(destroy: () => Promise<T>) => Promise<T> = (destroy) => destroy()
): Promise<{ removed: true }> {
  const runtime = findRecipeRemovalOwner(userDataPath, params)
  if (!runtime?.runtimeEnvironmentId) {
    throw new Error('Recipe workspace ownership changed. Refresh and try again.')
  }
  // A provisioned root is the VM's primary checkout, protected from ordinary Git deletion.
  // After a failed destroy the checkout is already gone, so only the destroy is left to retry.
  const checkoutAlreadyRemoved =
    runtime.status === 'cleaned' ||
    (runtime.status === 'cleanup_failed' &&
      (runtime.cleanupStatus === 'failed' || runtime.cleanupStatus === 'succeeded'))
  if (!isProvisionedRoot(runtime) && !checkoutAlreadyRemoved) {
    const response = await ports.call(runtime.runtimeEnvironmentId, 'worktree.rm', {
      ...params,
      hostId: 'local',
      waitForBackgroundRemoval: true
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const removed = Removed.parse(response.result)
    if (removed.removing === true || removed.removed !== true) {
      throw new Error(
        'The checkout is still being removed. Retry after removal finishes to destroy its environment.'
      )
    }
  }
  const cleaned = await orderDestroy(() => ports.cleanup(runtime.id))
  if (cleaned.status !== 'cleaned') {
    throw new Error(
      cleaned.cleanupLastError ?? 'Environment destroy failed. Retry removal to finish cleanup.'
    )
  }
  return { removed: true }
}
