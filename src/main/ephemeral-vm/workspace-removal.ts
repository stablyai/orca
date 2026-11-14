import { z } from 'zod'
import type { WorktreeRemove } from '../../shared/rpc-contract/workspaces/worktree-params'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  findEphemeralVmWorkspaceOwner,
  isProvisionedRootRuntime
} from '../../shared/ephemeral-vm-workspace-owner'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  RecipeWorkspaceRemovalError,
  type RecipeEnvironmentDescription,
  type RecipeHostRemovalState
} from '../../shared/recipe-host-removal'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'

export type RecipeWorkspaceRemoveParams = z.infer<typeof WorktreeRemove>

export type RecipeWorkspaceRemoval = Record<string, unknown> & {
  removed: true
  host: { runtimeId: string; state: RecipeHostRemovalState }
}

// An accepted background removal answers { removed: false, removing: true }.
const Removed = z
  .object({ removed: z.boolean().optional(), removing: z.boolean().optional() })
  .passthrough()
const Worktrees = z
  .object({
    truncated: z.boolean().optional(),
    worktrees: z.array(
      z
        .object({
          id: z.string(),
          isMainWorktree: z.boolean().optional(),
          removing: z.boolean().optional()
        })
        .passthrough()
    )
  })
  .passthrough()

function findRecipeRemovalOwner(
  userDataPath: string,
  params: { worktree: string; hostId?: string }
): EphemeralVmRuntimeRecord | undefined {
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

/**
 * Only a caller that asked for the environment's destroy (`destroyHost`) is routed here; every
 * other removal of the same workspace keeps today's path, so no existing client changes behavior.
 */
export function ownsRecipeWorkspaceRemoval(
  userDataPath: string,
  params: RecipeWorkspaceRemoveParams
): boolean {
  return params.destroyHost === true && findRecipeRemovalOwner(userDataPath, params) !== undefined
}

function recipeDestroys(runtime: EphemeralVmRuntimeRecord): boolean {
  if (runtime.cleanupDisabled === true || runtime.recipe?.destroyDisabled === true) {
    return false
  }
  // Older records carry no recipe snapshot; the destroy then reads orca.yaml, so assume it has one.
  return runtime.recipe ? Boolean(runtime.recipe.destroy) : true
}

/** The recipe environments a phone's delete sheet names, keyed by workspace id, for one host. */
export function describeRecipeWorkspaceEnvironments(
  userDataPath: string,
  hostId: string
): ReadonlyMap<string, RecipeEnvironmentDescription> {
  const described = new Map<string, RecipeEnvironmentDescription>()
  const runtimes = listEphemeralVmRuntimes(userDataPath).filter(
    (runtime) =>
      runtime.workspaceId !== undefined &&
      runtime.runtimeEnvironmentId !== undefined &&
      runtime.status !== 'cleaned' &&
      toRuntimeExecutionHostId(runtime.runtimeEnvironmentId) === hostId
  )
  for (const runtime of runtimes) {
    const workspaceId = runtime.workspaceId ?? ''
    if (described.has(workspaceId)) {
      // Ambiguous ownership: name nothing, so the phone never asks for a destroy it can't name.
      described.set(workspaceId, { name: '', destroys: false })
      continue
    }
    described.set(workspaceId, {
      name: runtime.workspaceName ?? runtime.recipe?.name ?? runtime.recipeId,
      destroys: recipeDestroys(runtime)
    })
  }
  for (const [workspaceId, description] of described) {
    if (!description.name) {
      described.delete(workspaceId)
    }
  }
  return described
}

type CheckoutRemovalWait = { attempts: number; intervalMs: number }
const DEFAULT_CHECKOUT_REMOVAL_WAIT: CheckoutRemovalWait = { attempts: 60, intervalMs: 2_000 }

/** True once the environment positively says the workspace no longer exists. */
async function waitForCheckoutGone(
  ports: {
    call: (
      environmentId: string,
      method: string,
      params: unknown
    ) => Promise<RuntimeRpcResponse<unknown>>
  },
  environmentId: string,
  worktree: string,
  wait: CheckoutRemovalWait
): Promise<boolean> {
  for (let attempt = 0; attempt < wait.attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, wait.intervalMs))
    const shown = await ports.call(environmentId, 'worktree.show', { worktree })
    if (!shown.ok && shown.error.code === 'selector_not_found') {
      return true
    }
  }
  return false
}

function rpcFailure(response: Extract<RuntimeRpcResponse<unknown>, { ok: false }>): Error {
  return new RecipeWorkspaceRemovalError(
    response.error.code,
    response.error.message,
    response.error.data
  )
}

/**
 * The provisioning host runs the destroy; the environment's own Orca still owns Git and process
 * teardown. Only a positive answer from the environment counts as removed, and the destroy runs
 * only once its last workspace is gone.
 */
export async function removeRecipeWorkspace(
  userDataPath: string,
  params: RecipeWorkspaceRemoveParams,
  ports: {
    call: (
      environmentId: string,
      method: string,
      params: unknown
    ) => Promise<RuntimeRpcResponse<unknown>>
    cleanup: (runtimeId: string) => Promise<EphemeralVmRuntimeRecord>
  },
  /** Orders the destroy behind the workspace's in-flight VM wake or suspend. */
  orderDestroy: <T>(destroy: () => Promise<T>) => Promise<T> = (destroy) => destroy(),
  waitForRemoval: CheckoutRemovalWait = DEFAULT_CHECKOUT_REMOVAL_WAIT
): Promise<RecipeWorkspaceRemoval> {
  const runtime = findRecipeRemovalOwner(userDataPath, params)
  if (!runtime?.runtimeEnvironmentId) {
    throw new Error('Recipe workspace ownership changed. Refresh and try again.')
  }
  const environmentId = runtime.runtimeEnvironmentId
  const { destroyHost: _destroyHost, ...forwarded } = params
  let checkoutResult: Record<string, unknown> = {}
  // A provisioned root is the VM's primary checkout, protected from ordinary Git deletion.
  if (!isProvisionedRootRuntime(runtime)) {
    // The checkout lives on the environment's own Orca, which has to be awake to remove it.
    if (runtime.status === 'suspended') {
      throw new Error(
        "This workspace's environment is asleep. Open the workspace to wake it, then delete it again."
      )
    }
    const response = await ports.call(environmentId, 'worktree.rm', {
      ...forwarded,
      hostId: 'local',
      waitForBackgroundRemoval: true
    })
    // The environment positively reporting no such workspace (an earlier removal whose destroy
    // failed or whose reply was lost) proves the checkout is gone; anything else blocks the destroy.
    const alreadyGone = !response.ok && response.error.code === 'selector_not_found'
    if (!response.ok && !alreadyGone) {
      throw rpcFailure(response)
    }
    if (response.ok) {
      const removed = Removed.parse(response.result)
      // An older environment Orca answers on acceptance; wait for the checkout to disappear, since
      // afterwards the phone can no longer find the row to ask again.
      if (
        (removed.removing === true || removed.removed !== true) &&
        !(await waitForCheckoutGone(ports, environmentId, params.worktree, waitForRemoval))
      ) {
        throw new Error(
          'The checkout is still being removed. Its environment was not destroyed; destroy it from Settings > Cloud VMs in Orca once removal finishes.'
        )
      }
      checkoutResult = { ...removed, removed: true }
    }
    // Other workspaces on the same environment keep it alive; no answer is not proof it's empty.
    const listed = await ports.call(environmentId, 'worktree.list', {})
    const parsedList = listed.ok ? Worktrees.safeParse(listed.result).data : undefined
    const remaining =
      parsedList && parsedList.truncated !== true
        ? parsedList.worktrees.filter(
            (worktree) =>
              worktree.isMainWorktree !== true &&
              worktree.removing !== true &&
              worktree.id !== params.worktree.slice(3)
          )
        : undefined
    if (!remaining || remaining.length > 0) {
      return { ...checkoutResult, removed: true, host: { runtimeId: runtime.id, state: 'kept' } }
    }
  }
  const cleaned = await orderDestroy(() => ports.cleanup(runtime.id))
  if (cleaned.status !== 'cleaned') {
    throw new RecipeWorkspaceRemovalError(
      'recipe_host_destroy_failed',
      `${cleaned.cleanupLastError ?? 'Environment destroy failed.'} The environment (runtime ${runtime.id}) may still be running; retry the cleanup from Settings > Cloud VMs in Orca.`,
      { runtimeId: runtime.id }
    )
  }
  return {
    ...checkoutResult,
    removed: true,
    host: {
      runtimeId: runtime.id,
      // A recipe without a destroy step is marked cleaned without running anything.
      state: cleaned.cleanupStatus === 'disabled' ? 'left-running' : 'destroyed'
    }
  }
}
