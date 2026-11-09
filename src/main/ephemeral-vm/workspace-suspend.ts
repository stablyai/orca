import { app } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { findWorkspaceEphemeralVmRuntime } from '../../shared/ephemeral-vm-workspace-runtime'
import { suspendEphemeralVmRuntime } from './runtime-service'
import { disconnectRuntimeOwnedSshTarget } from './runtime-ssh'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'

export async function suspendEphemeralVmWorkspace(
  store: Store,
  workspaceId: string
): Promise<void> {
  const userDataPath = app.getPath('userData')
  const runtime = findWorkspaceEphemeralVmRuntime(userDataPath, workspaceId)
  if (!runtime) {
    return
  }
  const recipeContext = getRuntimeRecipeContext(store, userDataPath, runtime.id)
  const result = await suspendEphemeralVmRuntime({
    userDataPath,
    repoPath: recipeContext.repoPath,
    recipe: recipeContext.recipe,
    runtimeId: runtime.id
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  // A skipped suspend leaves the VM running, so its SSH connection must remain live.
  if (runtime.connectionMode === 'ssh' && !result.skipped) {
    // Keep a successfully suspended VM resume-eligible even if local SSH teardown fails.
    await disconnectRuntimeOwnedSshTarget(runtime.sshTargetId).catch(() => undefined)
  }
}
