// Key changes inside the VM, made by the control plane (it runs the image's orca-ssh-keys).
import type { HostedSandboxSshAccess } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { HostedSandboxControlPlaneClient } from '../hosted-sandbox/hosted-sandbox-control-plane-client'
import type { CloudSshStaleKey } from './cloud-ssh-store'
import { CloudSshError, controlPlaneError } from './cloud-ssh-workspaces'

export async function installVmKey(
  client: HostedSandboxControlPlaneClient | null,
  sandboxId: string,
  publicKey: string
): Promise<HostedSandboxSshAccess> {
  if (!client) {
    throw new CloudSshError('not_configured', 'Orca Cloud is not set up in this build of Orca.')
  }
  try {
    return await client.installSshKey(sandboxId, publicKey)
  } catch (error) {
    throw controlPlaneError(error)
  }
}

/** Finishes revokes this runtime's VM slept through; a key that still fails stays queued. */
export async function removeStaleVmKeys(
  client: HostedSandboxControlPlaneClient | null,
  runtimeId: string,
  staleKeys: readonly CloudSshStaleKey[]
): Promise<CloudSshStaleKey[]> {
  const remaining: CloudSshStaleKey[] = []
  for (const stale of staleKeys) {
    if (stale.runtimeId !== runtimeId || !client) {
      remaining.push(stale)
      continue
    }
    try {
      await client.removeSshKey(stale.sandboxId, stale.publicKey)
    } catch {
      remaining.push(stale)
    }
  }
  return remaining
}
