import type { DaemonClientConnections } from './daemon-client-connections'
import type { DaemonFileLog } from '../observability/daemon-file-log'

export const RETIRE_WHEN_IDLE_REQUEST = 'retireWhenIdle'

/**
 * A newer app's connection stops keeping this older daemon alive; once only such connections
 * remain, the ordinary idle shutdown retires it the moment it owns no work. Older daemons answer
 * this request as unknown, so it needs no protocol-generation change.
 */
export function answer(
  request: { type: string; payload?: unknown },
  clientId: string,
  connections: DaemonClientConnections,
  log: DaemonFileLog,
  reevaluateIdleShutdown: () => void
): Promise<Record<string, never>> | undefined {
  if (request.type !== RETIRE_WHEN_IDLE_REQUEST) {
    return undefined
  }
  return Promise.resolve().then(() => {
    const { payload } = request
    const newer =
      typeof payload === 'object' && payload !== null && 'currentProtocolVersion' in payload
        ? payload.currentProtocolVersion
        : undefined
    // The current generation never retires on request; only a newer app may supersede this one.
    if (typeof newer !== 'number' || !Number.isSafeInteger(newer) || newer <= connections.protocolVersion) {
      throw new Error('retireWhenIdle refused: no newer generation named')
    }
    const client = connections.get(clientId)
    if (!client?.authenticatedPairEstablished || client.streamSocket === null) {
      throw new Error('Daemon client connection is incomplete; reconnect')
    }
    client.superseded = true
    log.log('retire-when-idle-requested', { newerProtocolVersion: newer })
    // After the reply is queued, so a daemon that is already empty answers before it closes.
    setImmediate(reevaluateIdleShutdown)
    return {}
  })
}

export function anyClient(connections: DaemonClientConnections): boolean {
  return [...connections.values()].some((client) => client.superseded)
}

/** Every connection, and every open transport, belongs to a superseding client. */
export function onlyClients(connections: DaemonClientConnections): boolean {
  const clients = [...connections.values()]
  return (
    clients.length > 0 &&
    clients.every((client) => client.superseded) &&
    connections.hasOnlyTransportsOf(clients)
  )
}
