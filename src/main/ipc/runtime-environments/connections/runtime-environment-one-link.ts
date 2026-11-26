import {
  remoteRuntimeOneLinkLocallyDisabled,
  remoteRuntimeOneLinkTestSwitchOn,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import { isRuntimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { ORCA_CLOUD_RELAY_ONE_LINK_FLAG } from '../../../../shared/orca-profiles/orca-cloud-capabilities'
import { isActiveCloudFlagOn } from '../../../orca-profiles/cloud-auth/active-team-capabilities'
import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { RUNTIME_BINARY_CHANNELS_CAPABILITY } from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'
import { isWslOrcadEnvironmentId } from '../../../wsl/orcad/wsl-orcad-environment-id'

/**
 * Whether a host gets one link for everything; the one place this is decided. Support's local off
 * switch wins over all. A host paired over Relay: when Orca Cloud's rollout includes this account
 * (or the test switch is on in a dev build), and then always, since that link is its only way
 * there. A direct host: only under the test switch, never in a shipped build, and never a WSL host,
 * whose open browser pane's own socket is what holds it awake.
 */
export function remoteRuntimeOneLinkAllowed(
  environmentId: string,
  connection: PairedRuntimeConnection
): boolean {
  if (remoteRuntimeOneLinkLocallyDisabled()) {
    return false
  }
  if (isRuntimeRelayEndpoint(connection.endpoint)) {
    return remoteRuntimeOneLinkTestSwitchOn() || isActiveCloudFlagOn(ORCA_CLOUD_RELAY_ONE_LINK_FLAG)
  }
  return remoteRuntimeOneLinkTestSwitchOn() && !isWslOrcadEnvironmentId(environmentId)
}

/**
 * After each verified status: a host that takes binary channels gets one link for everything,
 * when one-link mode is allowed; otherwise its streams and one-shot calls keep sockets of their own.
 */
export function noteOneLinkHostCapabilities(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection,
  hostCapabilities: readonly string[] | undefined,
  control: () => RemoteRuntimeSharedControlConnection
): void {
  const oneLink =
    remoteRuntimeOneLinkAllowed(environmentId, pairedConnection) &&
    (isRuntimeRelayEndpoint(pairedConnection.endpoint) ||
      (hostCapabilities?.includes(RUNTIME_BINARY_CHANNELS_CAPABILITY) ?? false))
  setRemoteRuntimeOneLink(environmentId, pairedConnection, oneLink ? control : null)
}
