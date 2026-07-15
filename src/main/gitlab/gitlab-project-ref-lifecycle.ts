import { getSshGitProviderRegistrationId } from '../providers/ssh-git-dispatch'
import type { ProjectRef } from './project-ref-parser'

type ProjectRefLifecycle = {
  connectionId: string
  providerRegistrationId: number
}

export function rememberProjectRefLifecycle(
  projectRef: ProjectRef,
  connectionId: string | null | undefined,
  sshProviderRegistrationId: number | undefined
): void {
  if (!connectionId || sshProviderRegistrationId === undefined) {
    return
  }
  // Why: project refs cross IPC/RPC before later mutations, so lifecycle
  // provenance must be serializable rather than process-local metadata.
  projectRef.sshConnectionLease = {
    connectionId,
    providerRegistrationId: sshProviderRegistrationId
  }
}

export function assertProjectRefCurrentForConnection(
  projectRef: ProjectRef,
  connectionId: string | null | undefined
): void {
  const lifecycle: ProjectRefLifecycle | undefined = projectRef.sshConnectionLease
  // Why: pasted URLs and locally resolved refs are not tied to an SSH
  // provider registration and remain usable across all provider types.
  if (!lifecycle) {
    return
  }
  const currentConnectionId = connectionId ?? null
  if (
    lifecycle.connectionId !== currentConnectionId ||
    getSshGitProviderRegistrationId(lifecycle.connectionId) !== lifecycle.providerRegistrationId
  ) {
    throw new Error('GitLab project resolution expired after the SSH connection changed')
  }
}
