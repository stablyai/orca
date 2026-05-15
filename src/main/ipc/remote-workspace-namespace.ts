import { createHash } from 'crypto'
import type { SshTarget } from '../../shared/ssh-types'

export function getRemoteWorkspaceNamespace(target: SshTarget): string {
  const stableKey = [
    target.configHost || target.host,
    target.host,
    String(target.port),
    target.username
  ].join('\n')
  return createHash('sha256').update(stableKey).digest('hex').slice(0, 32)
}
