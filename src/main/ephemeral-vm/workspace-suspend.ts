import { app } from 'electron'
import type { Store } from '../persistence'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { suspendEphemeralVmRuntime } from './runtime-service'
import { disconnectRuntimeOwnedSshTarget } from './runtime-ssh'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'

/** Suspends the VM a workspace runs on; a workspace with no VM does nothing. */
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
  // Only tear down SSH for a real suspend; a skipped suspend keeps the runtime
  // 'running', so disconnecting would break the still-active session with no resume.
  if (runtime.connectionMode === 'ssh' && !result.skipped) {
    // Why: the suspend recipe already succeeded (VM is suspended), so a failed
    // LOCAL relay teardown must NOT flip to 'suspend_failed' — that status is not
    // resume-eligible (see resume gate below), which would strand the runtime
    // unrecoverable. Keep 'suspended'; resume re-establishes the relay anyway.
    await disconnectRuntimeOwnedSshTarget(runtime.sshTargetId).catch(() => undefined)
  }
}
