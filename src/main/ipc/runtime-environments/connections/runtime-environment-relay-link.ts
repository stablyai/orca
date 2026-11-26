import { randomBytes, randomUUID } from 'node:crypto'
import { setRemoteRuntimeOneLink } from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { remoteRuntimeOneLinkAllowed } from './runtime-environment-one-link'
import type { AuthenticatedRuntimeChannelOpener } from '../../../../shared/remote-runtime/control/remote-runtime-authenticated-channel'
import {
  relayRuntimeChannelOpener,
  runtimeRelayLinkEntry
} from '../../../../shared/remote-runtime/control/remote-runtime-relay-authenticated-channel'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { isRuntimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import type { SharedHostLinkEntry } from '../../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'

// Test-only Relay pairings keep their resume credential for this app run; a restart pairs again.
const entries = new Map<string, SharedHostLinkEntry>()

/**
 * How a control connection reaches a host paired over Relay: its Relay link when one link is
 * allowed (it is the only way there), else a refusal. Null for any other host.
 */
export function relayControlChannelOpener(
  connection: PairedRuntimeConnection,
  allowed: boolean
): ((clientCapabilities: readonly string[]) => AuthenticatedRuntimeChannelOpener) | null {
  if (!isRuntimeRelayEndpoint(connection.endpoint)) {
    return null
  }
  if (!allowed) {
    return () => () => ({
      ok: false,
      error: new RemoteRuntimeClientError(
        'relay_one_link_off',
        'Connections to this server over Relay are turned off.'
      )
    })
  }
  const key = connection.credential.deviceToken
  return (clientCapabilities) =>
    relayRuntimeChannelOpener(connection, {
      platform: NODE_RELAY_CLIENT_PLATFORM,
      store: {
        entry: () => entries.get(key) ?? runtimeRelayLinkEntry(connection) ?? undefined,
        save: (entry) => void entries.set(key, entry)
      },
      clientCapabilities,
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      newId: randomUUID
    })
}

/** A control connection's one-link options for its host (runtime-environment-one-link.ts). */
export function controlLinkOptions(
  environmentId: string,
  connection: PairedRuntimeConnection
): Pick<RemoteRuntimeSharedControlConnectionOptions, 'binaryChannels' | 'openChannel'> {
  const oneLink = remoteRuntimeOneLinkAllowed(environmentId, connection)
  const openChannel = relayControlChannelOpener(connection, oneLink)
  return { binaryChannels: oneLink, ...(openChannel ? { openChannel } : {}) }
}

/** A host reached over Relay has no other way there: everything rides its link from the start. */
export function claimRelayOneLink(
  environmentId: string,
  connection: PairedRuntimeConnection,
  control: RemoteRuntimeSharedControlConnection
): void {
  if (
    isRuntimeRelayEndpoint(connection.endpoint) &&
    remoteRuntimeOneLinkAllowed(environmentId, connection)
  ) {
    setRemoteRuntimeOneLink(environmentId, connection, () => control)
  }
}
