import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { tryReadMetadata } from './metadata'
import { getCliStatus } from './status'

const WEBSOCKET_CONNECT_TIMEOUT_MS = 1_000

export type ServeRuntimeHealth =
  | { healthy: true; runtimeId: string }
  | {
      healthy: false
      reason:
        | 'metadata_missing'
        | 'runtime_unreachable'
        | 'runtime_changed'
        | 'graph_not_ready'
        | 'websocket_missing'
        | 'websocket_unreachable'
    }

type ServeRuntimeHealthOptions = {
  readMetadata?: (userDataPath: string) => RuntimeMetadata | null
  getStatus?: typeof getCliStatus
  connectWebSocket?: (endpoint: string) => Promise<boolean>
}

export async function probeServeRuntimeHealth(
  userDataPath: string,
  options: ServeRuntimeHealthOptions = {}
): Promise<ServeRuntimeHealth> {
  const metadata = (options.readMetadata ?? tryReadMetadata)(userDataPath)
  if (!metadata?.runtimeId) {
    return { healthy: false, reason: 'metadata_missing' }
  }

  const status = await (options.getStatus ?? getCliStatus)(userDataPath).catch(() => null)
  if (!status?.result.runtime.reachable) {
    return { healthy: false, reason: 'runtime_unreachable' }
  }
  if (status.result.runtime.runtimeId !== metadata.runtimeId) {
    return { healthy: false, reason: 'runtime_changed' }
  }

  const webSocket = findTransport(metadata, 'websocket')
  if (!webSocket) {
    return { healthy: false, reason: 'websocket_missing' }
  }
  const connected = await (options.connectWebSocket ?? connectWebSocketListener)(webSocket.endpoint)
  if (!connected) {
    return { healthy: false, reason: 'websocket_unreachable' }
  }
  if (status.result.graph.state !== 'ready') {
    return { healthy: false, reason: 'graph_not_ready' }
  }
  if (status.result.runtime.state !== 'ready') {
    return { healthy: false, reason: 'runtime_unreachable' }
  }
  return { healthy: true, runtimeId: metadata.runtimeId }
}

export async function connectWebSocketListener(endpoint: string): Promise<boolean> {
  const target = normalizeWebSocketEndpoint(endpoint)
  if (!target) {
    return false
  }

  const { default: WebSocket } = await import('ws')
  return await new Promise<boolean>((resolveResult) => {
    // This only verifies the local listener handshake; runtime RPC verifies authenticated health.
    const socket = new WebSocket(target, {
      handshakeTimeout: WEBSOCKET_CONNECT_TIMEOUT_MS
    })
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      socket.terminate()
      resolveResult(connected)
    }
    socket.once('open', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
  })
}

function normalizeWebSocketEndpoint(endpoint: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return null
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return null
  }
  if (!parsed.hostname) {
    return null
  }
  if (parsed.hostname === '0.0.0.0') {
    parsed.hostname = '127.0.0.1'
  }
  if (parsed.hostname === '::' || parsed.hostname === '[::]') {
    parsed.hostname = '[::1]'
  }
  return parsed
}
