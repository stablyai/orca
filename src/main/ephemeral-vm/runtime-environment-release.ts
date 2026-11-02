import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { removeManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments, removeEnvironment } from '../../shared/runtime-environment-store'
import { getOrcadSshDeployment } from '../../shared/runtime-environments'

/** Remove destroyed VM servers so managed tunnels stop reconnecting. */
export async function releaseEphemeralVmRuntimeEnvironments(
  userDataPath: string,
  runtime: Pick<EphemeralVmRuntimeRecord, 'runtimeEnvironmentId' | 'sshTargetId'>,
  // Same retirement as a Settings removal, so the host's session partition and transport go too.
  retireRemovedEnvironment: (environmentId: string) => void
): Promise<void> {
  // Relay-era conversions may have recorded only the SSH target, not the server ID.
  const environments = listEnvironments(userDataPath).filter(
    (entry) =>
      entry.id === runtime.runtimeEnvironmentId ||
      (runtime.sshTargetId !== undefined &&
        getOrcadSshDeployment(entry)?.sshTargetId === runtime.sshTargetId)
  )
  for (const environment of environments) {
    if (!environment.orcadDeployment) {
      removeEnvironment(userDataPath, environment.id)
      retireRemovedEnvironment(environment.id)
      continue
    }
    const { closeOrcadManagedTunnel } =
      await import('../managed-server/lifecycle/orcad-managed-tunnel')
    await closeOrcadManagedTunnel(environment.id).catch(() => undefined)
    removeManagedOrcadEnvironment(userDataPath, environment.id)
    retireRemovedEnvironment(environment.id)
  }
}
