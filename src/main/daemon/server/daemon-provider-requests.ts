import type { DaemonClientConnections } from './daemon-client-connections'
import type { DaemonTerminalAdmission } from './daemon-terminal-admission'
import type { TerminalHost } from '../terminal-host/terminal-host'
import type { DaemonRequest } from '../protocol/daemon-rpc-contract'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { DaemonProviderProcesses } from './daemon-provider-processes'
import type { DaemonServerLifecycle } from './daemon-server-lifecycle'

export function routeProviderRequest(
  request: Extract<DaemonRequest, { type: 'spawnProvider' | 'signalProvider' | 'queryProvider' }>,
  client: ConnectedDaemonClient | undefined,
  options: { providerProcesses?: DaemonProviderProcesses; lifecycle: DaemonServerLifecycle }
): unknown {
  const providers = options.providerProcesses
  if (
    !client?.authenticatedPairEstablished ||
    !providers?.enabled ||
    !options.lifecycle.isAcceptingWork()
  ) {
    throw new Error('Provider host unavailable')
  }
  if (request.type === 'spawnProvider') {
    return providers.spawn(request.payload, client.controlSocket)
  }
  if (request.type === 'signalProvider') {
    return providers.signal(request.payload.nonce, client.controlSocket, request.payload.signal)
  }
  return providers.query(request.payload.nonce, client.controlSocket, request.payload.acknowledge)
}

export function canRetireDaemon(
  options: {
    connections: DaemonClientConnections
    admission: DaemonTerminalAdmission
    providerProcesses?: DaemonProviderProcesses
    host: TerminalHost
  },
  client: ConnectedDaemonClient | undefined
): client is ConnectedDaemonClient {
  return (
    client !== undefined &&
    client.streamSocket !== null &&
    options.connections.size === 1 &&
    options.admission.inFlight === 0 &&
    !options.providerProcesses?.hasLive &&
    options.host.listSessions().length === 0 &&
    options.connections.hasOnlyTransportsFor(client)
  )
}
