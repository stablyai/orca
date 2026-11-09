import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  findEphemeralVmWorkspaceOwner,
  isProvisionedRootRuntime,
  isRecipeDestroyDisabled,
  RECIPE_REMOVAL_REQUEST_TIMEOUT_MS
} from '../../shared/ephemeral-vm-workspace-owner'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { WorktreeRemove } from '../../shared/rpc-contract/worktree-params'
import { WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { pluginDevWatchConfirmFor } from '../plugin-dev-watch/plugin-dev-watch-approval'
import { RuntimeClient } from './client'
import { RuntimeClientError, type RuntimeCallOptions, type RuntimeRpcSuccess } from './types'

export type OwnedRecipeRemovalOptions = {
  /** The full workspace id `worktree.show` resolved, so any selector finds its recipe owner. */
  worktreeId: string
  /** `--yes`: the caller already agreed to destroy the environment. */
  yes: boolean
  json: boolean
}

function findOwner(
  client: RuntimeClient,
  worktreeId: string,
  hostId: string
): { runtime: EphemeralVmRuntimeRecord; hostId: string } | undefined {
  // Through --environment, only the environment's own checkout (`local` there) can be its recipe
  // workspace; this computer's records name that host by the environment's id.
  if (client.isRemote && hostId !== 'local') {
    return undefined
  }
  const ownerHostId =
    client.isRemote && client.environmentSelector
      ? toRuntimeExecutionHostId(
          resolveEnvironment(client.userDataPath, client.environmentSelector).id
        )
      : hostId
  const runtime = findEphemeralVmWorkspaceOwner(
    listEphemeralVmRuntimes(client.userDataPath),
    worktreeId,
    ownerHostId
  )
  // Without a serving Orca on the environment there is no checkout host to ask; keep the old path.
  return runtime?.runtimeEnvironmentId ? { runtime, hostId: ownerHostId } : undefined
}

async function confirmDestroy(
  runtime: EphemeralVmRuntimeRecord,
  options: OwnedRecipeRemovalOptions
): Promise<void> {
  if (options.yes || runtime.status === 'cleaned' || isRecipeDestroyDisabled(runtime)) {
    return
  }
  const name = runtime.workspaceName ?? runtime.id
  const warning = `Removing this workspace also destroys its environment "${name}" (recipe ${runtime.recipeId}), with any uncommitted work and running terminals on it.`
  const confirm = pluginDevWatchConfirmFor(options.json)
  if (!confirm) {
    throw new RuntimeClientError('confirmation_required', `${warning} Pass --yes to continue.`, {
      runtimeId: runtime.id,
      recipeId: runtime.recipeId
    })
  }
  if (!(await confirm(`${warning}\nDestroy it? [y/N] `))) {
    throw new RuntimeClientError('cancelled', 'Cancelled; nothing was removed.')
  }
}

/**
 * Sends removal of a recipe workspace this computer provisioned to this computer's Orca, which
 * removes the checkout on the environment and then runs the recipe's destroy once. Returns
 * undefined for every other workspace, which removes in place as before.
 */
export async function removeOwnedRecipeWorkspace<TResult>(
  client: RuntimeClient,
  params: unknown,
  requestSelection: NonNullable<RuntimeCallOptions['requestSelection']>,
  options: OwnedRecipeRemovalOptions
): Promise<RuntimeRpcSuccess<TResult> | undefined> {
  const removal = WorktreeRemove.parse(params)
  if (!removal.hostId) {
    return undefined
  }
  const owner = findOwner(client, options.worktreeId, removal.hostId)
  if (!owner) {
    return undefined
  }
  const provisioner = client.isRemote
    ? new RuntimeClient(client.userDataPath, undefined, null, null)
    : client
  const status = await provisioner.call<RuntimeStatus>('status.get').catch((error: unknown) => {
    if (!client.isRemote) {
      throw error
    }
    throw new RuntimeClientError(
      'runtime_unavailable',
      'This workspace runs on a recipe environment created by this computer. Start the Orca desktop app here so removing it also destroys the environment, then retry.'
    )
  })
  if (!status.result.capabilities?.includes(WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This workspace runs on a recipe environment. Update the Orca desktop app on this computer so removing it also destroys the environment.'
    )
  }
  await confirmDestroy(owner.runtime, options)
  // The provisioning host's own status picks the request shape, so --delete-branch follows it.
  const selected = WorktreeRemove.parse(requestSelection.paramsForStatus(status.result))
  requestSelection.onDispatch?.()
  const provisionedRoot = isProvisionedRootRuntime(owner.runtime)
  return provisioner.call<TResult>(
    'worktree.rm',
    {
      ...selected,
      worktree: `id:${options.worktreeId}`,
      hostId: owner.hostId,
      // A provisioned root is the environment's only checkout; the confirmation above covers it.
      ...(provisionedRoot ? { force: true } : {})
    },
    { timeoutMs: RECIPE_REMOVAL_REQUEST_TIMEOUT_MS }
  )
}
