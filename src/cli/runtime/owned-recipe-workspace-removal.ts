import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { findEphemeralVmWorkspaceOwner } from '../../shared/ephemeral-vm-workspace-owner'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { WorktreeRemove } from '../../shared/rpc-contract/worktree-params'
import { WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeClient } from './client'
import { RuntimeClientError, type RuntimeRpcSuccess } from './types'

export async function removeOwnedRecipeWorkspace<TResult>(args: {
  method: string
  params: unknown
  userDataPath: string
  requestTimeoutMs: number
  environmentSelector: string | null
  createOwner: () => RuntimeClient
}): Promise<RuntimeRpcSuccess<TResult> | undefined> {
  if (args.environmentSelector && args.method === 'worktree.rm') {
    const environment = resolveEnvironment(args.userDataPath, args.environmentSelector)
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
      const owner = args.createOwner()
      const status = await owner.call<RuntimeStatus>('status.get')
      if (!status.result.capabilities?.includes(WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY)) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'Update Orca on the provisioning host before removing a recipe workspace.'
        )
      }
      return owner.call<TResult>(args.method, { ...removal, hostId }, { timeoutMs: 600_000 })
    }
  }
  return undefined
}
