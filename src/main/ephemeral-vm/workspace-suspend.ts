import { app } from 'electron'
import type { Store } from '../persistence'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { suspendEphemeralVmRuntime } from './runtime-service'
import { disconnectRuntimeOwnedSshTarget } from './runtime-ssh'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'

export async function suspendEphemeralVmWorkspace(
  store: Store,
  workspaceId: string
): Promise<void> {
  const userDataPath = app.getPath('userData')
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (entry) =>
      entry.workspaceId === workspaceId &&
      entry.status !== 'cleaned' &&
      entry.status !== 'cleanup_pending'
  )
  if (!runtime?.repoId) {
    return
  }
  const recipeContext = getRuntimeRecipeContext(store, userDataPath, runtime.id)
  const result = await suspendEphemeralVmRuntime({
    userDataPath,
    repoPath: recipeContext.repo.repo.path,
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
