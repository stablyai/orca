import type { OrcadHostTransport } from './orcad-host-transport'
import type { SshConnection } from './connection/ssh-connection'

/**
 * An SSH host's orcad transport is its connection itself, not a wrapper: tunnel ownership, serving
 * dedupe and per-connection caches compare and key by that object.
 */
export function sshOrcadHostTransport(connection: SshConnection): OrcadHostTransport {
  return connection
}
