import type { SshConnectionStatus } from '../../../src/shared/ssh-types'
import { hostUnionArms } from '../../../src/shared/zod-salvage'

// hostUnionArms makes additions or removals in the host union fail typecheck here.
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
