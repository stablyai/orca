import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { isRuntimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { ensureRemoteRuntimeSharedControlConnection } from './runtime-environment-request-connections'

/** A host reached only over Relay has no other way there: its control connection opens on first
 *  use, which claims its one link before a call or stream looks for it. */
export function openRelayHostLink(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection
): void {
  if (isRuntimeRelayEndpoint(pairedConnection.endpoint)) {
    ensureRemoteRuntimeSharedControlConnection(environmentId, pairedConnection)
  }
}
