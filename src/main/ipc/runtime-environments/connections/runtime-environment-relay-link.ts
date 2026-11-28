import { randomBytes, randomUUID } from 'node:crypto'
import {
  clearRemoteRuntimeOneLink,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { remoteRuntimeOneLinkAllowed } from './runtime-environment-one-link'
import { onTeamCapabilitiesInvalidated } from '../../../orca-profiles/cloud-auth/active-team-capabilities'
import type { AuthenticatedRuntimeChannelOpener } from '../../../../shared/remote-runtime/control/remote-runtime-authenticated-channel'
import { sharedHostKey } from '../../../../shared/remote-runtime/pairing/shared-host-keys'
import {
  relayRuntimeChannelOpener,
  runtimeRelayLinkEntry,
  type RuntimeRelayCredentialStore
} from '../../../../shared/remote-runtime/control/remote-runtime-relay-authenticated-channel'
import { RelayRuntimeDialMemory } from '../../../../shared/remote-runtime/control/remote-runtime-relay-dial-memory'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { isRuntimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import type { SharedHostLinkEntry } from '../../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { pairedRuntimeConnectionIdentity } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'

// Test-only Relay pairings keep their resume credential for this app run; a restart pairs again.
const entries = new Map<string, SharedHostLinkEntry>()
// Each Relay host's dial memory, so an explicit Connect or a wake can lift its offline hold.
const dialMemories = new Map<string, RelayRuntimeDialMemory>()
// Relay channels open now, each with its one-link decision and a cut that ends it as a drop.
const liveRelayChannels = new Set<{ allowed: () => boolean; cut: () => void }>()

/**
 * How a control connection reaches a host paired over Relay: its Relay link, the only way there.
 * Whether one link is allowed is read on every dial, so Orca Cloud turning it on or off (or the
 * account's session loading after startup) applies to the next dial. Null for any other host.
 */
export function relayControlChannelOpener(
  connection: PairedRuntimeConnection,
  allowed: () => boolean,
  // Across this connection's dials: its 4404 hold and streak, the cell the director last named.
  memory = new RelayRuntimeDialMemory(),
  // Tests reach a stand-in cell; the app dials the real one.
  platform = NODE_RELAY_CLIENT_PLATFORM,
  // A shared agent's host keeps its Relay credentials with its share; a test pairing, here.
  sharedHostRelay?: RuntimeRelayCredentialStore
): ((clientCapabilities: readonly string[]) => AuthenticatedRuntimeChannelOpener) | null {
  if (!isRuntimeRelayEndpoint(connection.endpoint)) {
    return null
  }
  const key = pairedRuntimeConnectionIdentity(connection)
  // A host signed in to by key is a share's: once the share is gone, nothing is left to dial.
  const store: RuntimeRelayCredentialStore =
    sharedHostRelay ??
    (connection.credential.kind === 'device-key'
      ? { entry: () => undefined, save: () => {} }
      : {
          entry: () => entries.get(key) ?? runtimeRelayLinkEntry(connection) ?? undefined,
          save: (entry) => void entries.set(key, entry)
        })
  return (clientCapabilities) => {
    const relay = relayRuntimeChannelOpener(connection, {
      platform,
      store,
      clientCapabilities,
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      newId: randomUUID,
      memory
    })
    return (events) => {
      if (!allowed()) {
        return { ok: false, error: relayOneLinkOffError() }
      }
      const live = { allowed, cut: () => {} }
      const opened = relay({
        ...events,
        onClosed: (...closed) => {
          liveRelayChannels.delete(live)
          events.onClosed(...closed)
        }
      })
      if (!opened.ok) {
        return opened
      }
      const { channel } = opened
      const close = (): void => {
        liveRelayChannels.delete(live)
        channel.close()
      }
      live.cut = () => {
        close()
        events.onClosed(relayOneLinkOffError(), 'socket_close')
      }
      liveRelayChannels.add(live)
      return { ok: true, channel: { ...channel, close } }
    }
  }
}

/** A control connection's one-link options for its host (runtime-environment-one-link.ts). */
export function controlLinkOptions(
  environmentId: string,
  connection: PairedRuntimeConnection,
  // Tests reach a stand-in cell; the app dials the real one.
  platform = NODE_RELAY_CLIENT_PLATFORM
): Pick<RemoteRuntimeSharedControlConnectionOptions, 'binaryChannels' | 'openChannel'> {
  const memory = new RelayRuntimeDialMemory()
  const openChannel = relayControlChannelOpener(
    connection,
    () => remoteRuntimeOneLinkAllowed(environmentId, connection),
    memory,
    platform,
    sharedHostKey(environmentId)?.relay
  )
  if (openChannel) {
    dialMemories.set(environmentId, memory)
  }
  if (openChannel) {
    // Its link is all a Relay host has, so it always carries channels; the opener decides per dial.
    return { binaryChannels: true, openChannel }
  }
  return { binaryChannels: remoteRuntimeOneLinkAllowed(environmentId, connection) }
}

/**
 * A host reached over Relay has no other way there: everything rides its link from the start, and
 * when one link is off, callers hear that from the link instead of dialing an address it lacks.
 */
export function claimRelayOneLink(
  environmentId: string,
  connection: PairedRuntimeConnection,
  control: RemoteRuntimeSharedControlConnection
): void {
  if (isRuntimeRelayEndpoint(connection.endpoint)) {
    setRemoteRuntimeOneLink(environmentId, connection, () => control)
  }
}

/**
 * Orca Cloud turning one link off cuts live Relay links now, not only at their next dial. Each
 * control connection stays its host's link, so a stream reopening on it hears one link is off.
 */
export function cutRelayLinksTurnedOff(): void {
  for (const live of liveRelayChannels) {
    if (!live.allowed()) {
      live.cut()
    }
  }
}
onTeamCapabilitiesInvalidated(cutRelayLinksTurnedOff)

function relayOneLinkOffError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'relay_one_link_off',
    'Connections to this server over Relay are turned off.'
  )
}

/** Explicit Connect (one host) or the OS or network coming back (all): dial now, not after a hold. */
export function clearRelayDialHolds(environmentId?: string): void {
  for (const [id, memory] of dialMemories) {
    if (environmentId === undefined || id === environmentId) {
      memory.clearHold()
    }
  }
}

/** A host's control connection closed: it stops being the host's one link, and its dial memory goes. */
export function releaseRemoteRuntimeOneLink(environmentId: string): void {
  clearRemoteRuntimeOneLink(environmentId)
  dialMemories.delete(environmentId)
}
