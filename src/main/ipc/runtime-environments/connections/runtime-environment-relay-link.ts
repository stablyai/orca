import { randomBytes, randomUUID } from 'node:crypto'
import { setRemoteRuntimeOneLink } from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { remoteRuntimeOneLinkAllowed } from './runtime-environment-one-link'
import { onTeamCapabilitiesInvalidated } from '../../../orca-profiles/cloud-auth/active-team-capabilities'
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
// The control connection each host reached over Relay rides, by environment.
const claimed = new Map<
  string,
  {
    connection: PairedRuntimeConnection
    control: RemoteRuntimeSharedControlConnection
    close: (environmentId: string) => void
  }
>()
let stopWatchingCloudFlag: (() => void) | undefined

/**
 * How a control connection reaches a host paired over Relay: its Relay link, the only way there.
 * Whether one link is allowed is read on every dial, so Orca Cloud turning it on or off (or the
 * account's session loading after startup) applies to the next dial. Null for any other host.
 */
export function relayControlChannelOpener(
  connection: PairedRuntimeConnection,
  allowed: () => boolean
): ((clientCapabilities: readonly string[]) => AuthenticatedRuntimeChannelOpener) | null {
  if (!isRuntimeRelayEndpoint(connection.endpoint)) {
    return null
  }
  const key = connection.credential.deviceToken
  return (clientCapabilities) => {
    const relay = relayRuntimeChannelOpener(connection, {
      platform: NODE_RELAY_CLIENT_PLATFORM,
      store: {
        entry: () => entries.get(key) ?? runtimeRelayLinkEntry(connection) ?? undefined,
        save: (entry) => void entries.set(key, entry)
      },
      clientCapabilities,
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      newId: randomUUID
    })
    return (events) =>
      allowed()
        ? relay(events)
        : {
            ok: false,
            error: new RemoteRuntimeClientError(
              'relay_one_link_off',
              'Connections to this server over Relay are turned off.'
            )
          }
  }
}

/** A control connection's one-link options for its host (runtime-environment-one-link.ts). */
export function controlLinkOptions(
  environmentId: string,
  connection: PairedRuntimeConnection
): Pick<RemoteRuntimeSharedControlConnectionOptions, 'binaryChannels' | 'openChannel'> {
  const openChannel = relayControlChannelOpener(connection, () =>
    remoteRuntimeOneLinkAllowed(environmentId, connection)
  )
  if (openChannel) {
    // Its link is all a Relay host has, so it always carries channels; the opener decides per dial.
    return { binaryChannels: true, openChannel }
  }
  return { binaryChannels: remoteRuntimeOneLinkAllowed(environmentId, connection) }
}

/**
 * A host reached over Relay has no other way there: everything rides its link from the start, and
 * when one link is off, callers hear that from the link instead of dialing an address it lacks.
 * `close` drops the host's control connection, should Orca Cloud turn one link off while it is live.
 */
export function claimRelayOneLink(
  environmentId: string,
  connection: PairedRuntimeConnection,
  control: RemoteRuntimeSharedControlConnection,
  close: (environmentId: string) => void
): void {
  if (!isRuntimeRelayEndpoint(connection.endpoint)) {
    return
  }
  claimed.set(environmentId, { connection, control, close })
  stopWatchingCloudFlag ??= onTeamCapabilitiesInvalidated(closeRelayLinksTurnedOff)
  setRemoteRuntimeOneLink(environmentId, connection, () => control)
}

// Orca Cloud turning one link off cuts live Relay links now, not only at their next dial.
function closeRelayLinksTurnedOff(): void {
  for (const [environmentId, { connection, control, close }] of claimed) {
    if (control.getDiagnostics().state === 'closed') {
      continue
    }
    if (!remoteRuntimeOneLinkAllowed(environmentId, connection)) {
      claimed.delete(environmentId)
      close(environmentId)
    }
  }
}
