import type { OrcadHostTransport } from './orcad-host-transport'
import type { SshConnection } from './connection/ssh-connection'

/** Return the connection object itself: tunnel ownership, dedupe and caches depend on its identity. */
export function sshOrcadHostTransport(connection: SshConnection): OrcadHostTransport {
  return connection
}
