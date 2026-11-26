import {
  remoteRuntimeOneLinkTestSwitchOn,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { RUNTIME_BINARY_CHANNELS_CAPABILITY } from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'

/** Whether a host that takes binary channels gets one link for everything. Direct hosts only
 *  under the test switch; support's local off switch wins over it. */
export function remoteRuntimeOneLinkAllowed(): boolean {
  return remoteRuntimeOneLinkTestSwitchOn()
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
    remoteRuntimeOneLinkAllowed() &&
    (hostCapabilities?.includes(RUNTIME_BINARY_CHANNELS_CAPABILITY) ?? false)
  setRemoteRuntimeOneLink(environmentId, pairedConnection, oneLink ? control : null)
}
