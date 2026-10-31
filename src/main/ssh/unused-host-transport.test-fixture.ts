import type { SshConnection } from './connection/ssh-connection'
import type { OrcadHostTransport } from './orcad-host-transport'

// Placeholders for tests that mock every reader of the connection, so it is only forwarded.

export function unusedSshConnection(): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers mock all code that would read the connection; it is only passed through.
  return {} as SshConnection
}

export function unusedOrcadHostTransport(): OrcadHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers mock all code that would read the transport; it is only passed through.
  return {} as OrcadHostTransport
}
