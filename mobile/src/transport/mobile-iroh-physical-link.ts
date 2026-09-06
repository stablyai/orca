import type { ConnectionLogSink } from './types'
import { isIrohNativeModuleAvailable } from './mobile-iroh-availability'
import { MobileIrohFramedSocket } from './mobile-iroh-framed-socket'
import { connect, type RpcClient } from './rpc-client'

/** Synthetic URL used only for logs / redaction; createSocket ignores it. */
export function irohEndpointLogUrl(endpointId: string): string {
  return `iroh://${endpointId.slice(0, 12)}…`
}

/**
 * Opens an RpcClient over iroh (same E2EE + 20s status.get probe as LAN WS).
 * Returns null when the native module is missing / not implemented.
 */
export function openIrohRpcClient(args: {
  desktopEndpointId: string
  dialHints?: { relayUrl?: string; directAddresses?: string[] }
  deviceToken: string
  publicKeyB64: string
  onLog?: ConnectionLogSink
}): RpcClient | null {
  const { desktopEndpointId, dialHints, deviceToken, publicKeyB64, onLog } = args
  // Why: probe BEFORE constructing the socket — the socket's deferred load
  // failure would surface as an endless reconnect loop, never as null, and
  // callers' ws fallback branches would be unreachable.
  if (!isIrohNativeModuleAvailable()) {
    console.log('[iroh]', 'rpc_open_module_unavailable')
    return null
  }
  console.log('[iroh]', 'rpc_open', { endpointPrefix: desktopEndpointId.slice(0, 12) })
  try {
    return connect(irohEndpointLogUrl(desktopEndpointId), deviceToken, publicKeyB64, {
      onLog,
      createSocket: () =>
        new MobileIrohFramedSocket({
          desktopEndpointId,
          ...(dialHints ? { dialHints } : {}),
          onLog: (message, detail) => {
            console.log('[iroh]', 'socket', { message, detail })
            onLog?.({
              id: `iroh-${Date.now()}`,
              ts: Date.now(),
              level: message.toLowerCase().includes('fail') ? 'warn' : 'info',
              message,
              detail
            })
          }
        }) as unknown as WebSocket
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.log('[iroh]', 'rpc_open_throw', { error: detail })
    onLog?.({
      id: `iroh-open-${Date.now()}`,
      ts: Date.now(),
      level: 'error',
      message: 'Iroh native open failed',
      detail
    })
    return null
  }
}
