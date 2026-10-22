import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { removeManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments, removeEnvironment } from '../../shared/runtime-environment-store'
import { getOrcadSshDeployment } from '../../shared/runtime-environments'

/** Forgets the servers a destroyed VM ran; a managed one's tunnel would otherwise keep redialing. */
export async function releaseEphemeralVmRuntimeEnvironments(
  userDataPath: string,
  runtime: Pick<EphemeralVmRuntimeRecord, 'runtimeEnvironmentId' | 'sshTargetId'>
): Promise<void> {
  // Why the target too: a relay-era VM converted on connect never recorded its server's id.
  const environments = listEnvironments(userDataPath).filter(
    (entry) =>
      entry.id === runtime.runtimeEnvironmentId ||
      (runtime.sshTargetId !== undefined &&
        getOrcadSshDeployment(entry)?.sshTargetId === runtime.sshTargetId)
  )
  for (const environment of environments) {
    if (!environment.orcadDeployment) {
      removeEnvironment(userDataPath, environment.id)
      continue
    }
    const { closeOrcadManagedTunnel } =
      await import('../managed-server/lifecycle/orcad-managed-tunnel')
    await closeOrcadManagedTunnel(environment.id).catch(() => undefined)
    removeManagedOrcadEnvironment(userDataPath, environment.id)
  }
}
