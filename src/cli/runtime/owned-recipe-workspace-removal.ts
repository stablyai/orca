import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  findEphemeralVmWorkspaceOwner,
  RECIPE_REMOVAL_REQUEST_TIMEOUT_MS
} from '../../shared/ephemeral-vm-workspace-owner'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { WorktreeRemove } from '../../shared/rpc-contract/worktree-params'
import { WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClient } from './client'
import { RuntimeClientError, type RuntimeCallOptions, type RuntimeRpcSuccess } from './types'

export async function removeOwnedRecipeWorkspace<TResult>(
  client: RuntimeClient,
  method: string,
  params: unknown,
  requestSelection?: RuntimeCallOptions['requestSelection']
): Promise<RuntimeRpcSuccess<TResult> | undefined> {
  const { userDataPath } = client
  const environmentSelector = client.isRemote ? client.environmentSelector : null
  const args = { method, params, userDataPath, requestSelection }
  const createOwner = () => new RuntimeClient(userDataPath, undefined, null, null)
  if (environmentSelector && args.method === 'worktree.rm') {
    const environment = resolveEnvironment(args.userDataPath, environmentSelector)
    const removal = WorktreeRemove.parse(args.params)
    const hostId = `runtime:${environment.id}`
    if (
      removal.worktree.startsWith('id:') &&
      findEphemeralVmWorkspaceOwner(
        listEphemeralVmRuntimes(args.userDataPath),
        removal.worktree.slice(3),
        hostId
      )
    ) {
      const owner = createOwner()
      const status = await owner.call<RuntimeStatus>('status.get')
      if (!status.result.capabilities?.includes(WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY)) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'Update Orca on the provisioning host before removing a recipe workspace.'
        )
      }
      // The owner's own status picks the request shape, so --delete-branch survives its capabilities.
      const selected = args.requestSelection?.paramsForStatus(status.result)
      args.requestSelection?.onDispatch?.()
      const request = selected ? WorktreeRemove.parse(selected) : removal
      return owner.call<TResult>(
        args.method,
        { ...request, hostId },
        { timeoutMs: RECIPE_REMOVAL_REQUEST_TIMEOUT_MS }
      )
    }
  }
  return undefined
}
