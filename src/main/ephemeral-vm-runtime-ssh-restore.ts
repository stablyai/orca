import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { connectRegisteredSshTarget, getSshTargetRegistryStore } from './ssh/ssh-target-registry'
import { waitForRuntimeSshProviders } from './ephemeral-vm-runtime-ssh'

/** Reattach transport only: a running VM must not execute its resume recipe again. */
export async function restoreRuntimeOwnedSshTarget(
  userDataPath: string,
  runtimeId: string
): Promise<void> {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (
    runtime?.status !== 'running' ||
    runtime.connectionMode !== 'ssh' ||
    runtime.runtimeEnvironmentId
  ) {
    return
  }
  const target = runtime.sshTargetId
    ? getSshTargetRegistryStore()?.getTarget(runtime.sshTargetId)
    : undefined
  if (target?.owner?.type !== 'on-demand-runtime' || target.owner.runtimeId !== runtime.id) {
    throw new Error(`Registered SSH target is missing for runtime "${runtimeId}".`)
  }
  // connectRegisteredSshTarget coalesces attempts and fences suspend/remove/shutdown.
  // Unlike provisioning, failure must retain the registration so activation can retry.
  const state = await connectRegisteredSshTarget(target.id)
  if (state.status !== 'connected') {
    throw new Error(state.error || `SSH target did not connect: ${state.status}`)
  }
  await waitForRuntimeSshProviders(target.id)
}

/**
 * Reattach persisted running SSH VMs with at most four concurrent attempts.
 * Failures are logged independently so an unavailable VM does not block the others.
 */
export async function restoreRunningRuntimeOwnedSshTargets(userDataPath: string): Promise<void> {
  const runtimes = listEphemeralVmRuntimes(userDataPath).filter(
    (runtime) =>
      runtime.status === 'running' &&
      runtime.connectionMode === 'ssh' &&
      !runtime.runtimeEnvironmentId
  )
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, runtimes.length) }, async () => {
      while (next < runtimes.length) {
        const runtimeId = runtimes[next++].id
        try {
          // Re-read lifecycle state when dequeued; a VM may have been suspended meanwhile.
          await restoreRuntimeOwnedSshTarget(userDataPath, runtimeId)
        } catch (error) {
          console.warn('[runtime-ssh] Reattach failed:', runtimeId, error)
        }
      }
    })
  )
}
