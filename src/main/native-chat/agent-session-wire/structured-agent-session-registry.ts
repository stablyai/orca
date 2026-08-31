// Where the RPC layer finds the host.
//
// The runtime service is already far past its size budget, so structured
// sessions hang off a module-level slot instead of another field on it — the
// same shape the native-chat RPC methods use to reach their own collaborators.
// Tests install a host with a stub adapter and clear it on teardown.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'

let host: StructuredAgentSessionHost | null = null

export function setStructuredAgentSessionHost(next: StructuredAgentSessionHost | null): void {
  host = next
}

export function getStructuredAgentSessionHost(): StructuredAgentSessionHost | null {
  return host
}
