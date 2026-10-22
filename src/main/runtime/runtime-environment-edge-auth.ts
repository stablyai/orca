import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { readCachedRuntimeEdgeAuth } from '../credentials/runtime-edge-auth-store'
import { remoteRuntimeConnectOptions } from '../../shared/remote-runtime-connect-bound'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'

export function resolveRuntimeEnvironmentConnection(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): PairedRuntimeConnection {
  const connection = getPreferredPairedRuntimeConnection(environment)
  if (
    !connection.endpoint.toLowerCase().startsWith('wss://') ||
    environment.connectionDependency === 'ssh-tunnel' ||
    environment.orcadDeployment ||
    environment.sshAccess
  ) {
    return connection
  }
  const edgeAuth = readCachedRuntimeEdgeAuth(userDataPath, environment)
  if (!edgeAuth) {
    return connection
  }
  const authenticated = { ...connection, edgeAuth }
  remoteRuntimeConnectOptions(undefined, undefined, authenticated)
  return authenticated
}
