/** The latest server decision per SSH host, merged into every published connection state. */
import type { SshManagedServerStatus } from '../../shared/ssh-types'

const statuses = new Map<string, SshManagedServerStatus>()

export function setSshHostServerStatus(targetId: string, status: SshManagedServerStatus): void {
  statuses.set(targetId, status)
}

export function getSshHostServerStatus(targetId: string): SshManagedServerStatus | undefined {
  return statuses.get(targetId)
}

export function clearSshHostServerStatus(targetId: string): void {
  statuses.delete(targetId)
}
