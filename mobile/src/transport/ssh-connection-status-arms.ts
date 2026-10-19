import type { SshConnectionStatus } from '../../../src/shared/ssh-types'
import { hostUnionArms } from '../../../src/shared/zod-salvage'

// Pinned to the host's own union through hostUnionArms: an arm added or dropped host-side fails tsc.
export const SSH_CONNECTION_STATUS = hostUnionArms<SshConnectionStatus>({
  disconnected: true,
  connecting: true,
  'auth-failed': true,
  'deploying-relay': true,
  connected: true,
  reconnecting: true,
  'reconnection-failed': true,
  error: true
})

const KNOWN_SSH_CONNECTION_STATUSES: ReadonlySet<string> = new Set(SSH_CONNECTION_STATUS)

export function isSshConnectionStatus(status: string): status is SshConnectionStatus {
  return KNOWN_SSH_CONNECTION_STATUSES.has(status)
}
