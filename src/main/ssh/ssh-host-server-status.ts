import type { SshManagedServerStatus } from '../../shared/ssh-types'

const statuses = new Map<string, SshManagedServerStatus>()
let servedListener: ((targetId: string) => void) | null = null

/** A settled decision that keeps the SSH session up: a managed server, or the legacy relay bridge. */
export function isSshHostServed(status: SshManagedServerStatus | undefined): boolean {
  return status?.kind === 'managed' || (status?.kind === 'relay' && status.bridged === true)
}

/** Restore on every served publisher: tunnel startup can serve a host without an SSH connect (#32484). */
export function setSshHostServedListener(listener: ((targetId: string) => void) | null): void {
  servedListener = listener
}

export function setSshHostServerStatus(targetId: string, status: SshManagedServerStatus): void {
  statuses.set(targetId, status)
  if (isSshHostServed(status)) {
    servedListener?.(targetId)
  }
}

export function getSshHostServerStatus(targetId: string): SshManagedServerStatus | undefined {
  return statuses.get(targetId)
}

export function clearSshHostServerStatus(targetId: string): void {
  statuses.delete(targetId)
}
