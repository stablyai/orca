import { z } from 'zod'
import type { WorktreeRemove } from '../../shared/rpc-contract/worktree-params'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  findEphemeralVmWorkspaceOwner,
  isProvisionedRootRuntime,
  isRecipeDestroyDisabled
} from '../../shared/ephemeral-vm-workspace-owner'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

export type RecipeWorkspaceRemoveParams = z.infer<typeof WorktreeRemove>
/** `environment` says whether the recipe's destroy ran or the recipe disables it. */
export type RecipeWorkspaceRemoval = Record<string, unknown> & {
  removed: true
  environment: 'destroyed' | 'destroy-disabled'
}
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

/** A provisioned root skips Git, so removing it destroys the VM outright; require explicit confirmation. */
export function assertRecipeRemovalConfirmed(
  userDataPath: string,
  params: RecipeWorkspaceRemoveParams
): void {
  const runtime = findRecipeRemovalOwner(userDataPath, params)
  if (!runtime || !isProvisionedRootRuntime(runtime) || runtime.status === 'cleaned') {
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
): Promise<RecipeWorkspaceRemoval> {
  const runtime = findRecipeRemovalOwner(userDataPath, params)
  if (!runtime?.runtimeEnvironmentId) {
    throw new Error('Recipe workspace ownership changed. Refresh and try again.')
  }
  if (runtime.status === 'suspended') {
    throw new Error(
      "This workspace's environment is asleep. Open the workspace to wake it, then remove it again."
    )
  }
  let checkoutResult: Record<string, unknown> = {}
  // A provisioned root is the VM's primary checkout, protected from ordinary Git deletion.
  // After a failed destroy the checkout is already gone, so only the destroy is left to retry.
  const checkoutAlreadyRemoved =
    runtime.status === 'cleaned' ||
    (runtime.status === 'cleanup_failed' &&
      (runtime.cleanupStatus === 'failed' || runtime.cleanupStatus === 'succeeded'))
  if (!isProvisionedRootRuntime(runtime) && !checkoutAlreadyRemoved) {
    const response = await ports.call(runtime.runtimeEnvironmentId, 'worktree.rm', {
      ...params,
      hostId: 'local',
      waitForBackgroundRemoval: true
    })
    // The environment positively reporting no such workspace (an earlier removal's reply was
    // lost) proves the checkout is gone; any other failure, or no answer, blocks the destroy.
    const alreadyGone =
      !response.ok &&
      response.error.code === 'selector_not_found' &&
      runtime.workspaceId !== undefined
    if (!response.ok && !alreadyGone) {
      throw new Error(response.error.message)
    }
    if (response.ok) {
      const removed = Removed.parse(response.result)
      if (removed.removing === true || removed.removed !== true) {
        throw new Error(
          'The checkout is still being removed. Retry after removal finishes to destroy its environment.'
        )
      }
      checkoutResult = removed
    }
  }
  const cleaned = await orderDestroy(() => ports.cleanup(runtime.id))
  if (cleaned.status !== 'cleaned') {
    // The checkout may already be gone, so name a retry that still works without it.
    throw new Error(
      `${cleaned.cleanupLastError ?? 'Environment destroy failed.'} The environment (runtime ${runtime.id}) may still be running; retry the cleanup from Settings > Cloud VMs in Orca.`
    )
  }
  // Keep what the environment reported (hook waivers, branch evidence, warnings).
  return {
    ...checkoutResult,
    removed: true,
    environment: isRecipeDestroyDisabled(runtime) ? 'destroy-disabled' : 'destroyed'
  }
}
