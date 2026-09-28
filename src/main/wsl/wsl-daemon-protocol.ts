import {
  INITIAL_WSL_DAEMON_PROTOCOL_VERSION,
  type PersistedWslDaemonEndpoint
} from '../../shared/wsl-daemon-recovery'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'

export function retainedWslDaemonProtocolVersion(endpoint: PersistedWslDaemonEndpoint): number {
  const version = endpoint.protocolVersion ?? INITIAL_WSL_DAEMON_PROTOCOL_VERSION
  if (
    version < INITIAL_WSL_DAEMON_PROTOCOL_VERSION ||
    (version !== PROTOCOL_VERSION &&
      !PREVIOUS_DAEMON_PROTOCOL_VERSIONS.some((supported) => supported === version))
  ) {
    throw new Error(`WSL daemon protocol ${version} is unsupported; its terminals are unverifiable`)
  }
  return version
}
