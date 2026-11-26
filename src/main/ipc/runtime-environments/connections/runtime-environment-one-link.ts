import {
  remoteRuntimeOneLinkTestSwitchOn,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { RUNTIME_BINARY_CHANNELS_CAPABILITY } from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'
import { isWslOrcadEnvironmentId } from '../../../wsl/orcad/wsl-orcad-environment-id'

/**
 * Whether a host that takes binary channels gets one link for everything. Direct hosts only under
 * the test switch (never in a shipped build); support's local off switch wins over it. A WSL host
 * keeps a socket per stream: an open browser pane's own socket is what holds it awake.
 */
export function remoteRuntimeOneLinkAllowed(environmentId: string): boolean {
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
    remoteRuntimeOneLinkAllowed(environmentId) &&
    (hostCapabilities?.includes(RUNTIME_BINARY_CHANNELS_CAPABILITY) ?? false)
  setRemoteRuntimeOneLink(environmentId, pairedConnection, oneLink ? control : null)
}
