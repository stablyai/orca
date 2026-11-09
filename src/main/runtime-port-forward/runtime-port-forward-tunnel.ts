import '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from '../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RemoteRuntimeTransportSubscription } from '../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { BrowserNetworkTunnelEvent } from '../../shared/browser/client-hosting/browser-client-host-protocol'
import { WORKSPACE_PORTS_FORWARD_TUNNEL_RUNTIME_CAPABILITY } from '../../shared/workspace-ports-runtime-capabilities'
import { BrowserNetworkTunnelClient } from '../browser/network/tunnels/browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from '../browser/network/tunnels/browser-network-tunnel-duplex'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../browser/network/tunnels/browser-network-tunnel-stream-state'
import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'

const ATTACH_TIMEOUT_MS = 20_000
// Same socket budget as the browser tunnel: dev servers stream large bundles and HMR sockets.
const SOFT_CAP_BYTES = 1024 * 1024
const MAX_QUEUED_BYTES = 7 * 1024 * 1024

export class PortForwardTunnelError extends Error {
  constructor(
    readonly code: 'host_unsupported' | 'tunnel_failed',
    message: string
  ) {
    super(message)
  }
}

/** Opens one host session: a WebSocket subscription that multiplexes this client's forwarded connections. */
export type PortForwardTunnelConnector = (
  environmentId: string,
  onClosed: (error: Error) => void,
  /** Wake a sleeping VM first: only for explicit user actions, never a stray connection (an open tab). */
  options?: { wake: boolean }
) => Promise<{ client: BrowserNetworkTunnelClient; close: () => void }>

/** Subscribes to the host's forward tunnel over whatever paired connection `resolveConnection` returns. */
export function createPortForwardConnector(
  resolveConnection: (
    environmentId: string,
    options: { wake: boolean }
  ) => Promise<PairedRuntimeConnection>
): PortForwardTunnelConnector {
  return async (environmentId, onClosed, options = { wake: false }) => {
    const connection = await resolveConnection(environmentId, options)
    const ready = Promise.withResolvers<BrowserNetworkTunnelClient>()
    let client: BrowserNetworkTunnelClient | null = null
    let subscription: RemoteRuntimeTransportSubscription | null = null
    let closed = false
    const fail = (error: Error): void => {
      ready.reject(error)
      if (!closed) {
        closed = true
        client?.close(error)
        onClosed(error)
      }
    }
    subscription = await subscribeRemoteRuntimeTransport(
      connection,
      'workspacePorts.forwardTunnel',
      {},
      ATTACH_TIMEOUT_MS,
      {
        onResponse: (response) => {
          if (!response.ok) {
            fail(
              response.error.code === 'method_not_found'
                ? new PortForwardTunnelError(
                    'host_unsupported',
                    'This host needs an Orca update to forward ports.'
                  )
                : new PortForwardTunnelError('tunnel_failed', response.error.message)
            )
            return
          }
          const event = BrowserNetworkTunnelEvent.safeParse(response.result)
          if (!event.success || event.data.type === 'closed') {
            fail(new PortForwardTunnelError('tunnel_failed', 'The port forward tunnel closed.'))
            return
          }
          if (!client) {
            client = new BrowserNetworkTunnelClient({
              tunnelGeneration: event.data.tunnelGeneration,
              sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
              flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
              onClosed: (error) => fail(error)
            })
            ready.resolve(client)
          }
        },
        onBinary: (bytes) => client?.handleBinary(bytes),
        onError: (error) => fail(error),
        onClose: () =>
          fail(new PortForwardTunnelError('tunnel_failed', 'The port forward tunnel closed.'))
      },
      {
        perMessageDeflate: false,
        outboundQueue: {
          softCapBytes: SOFT_CAP_BYTES,
          maxQueuedBytes: MAX_QUEUED_BYTES,
          maxQueuedFrames: 2_048,
          maxDrainFramesPerTurn: 4
        },
        clientCapabilities: [
          ...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
          WORKSPACE_PORTS_FORWARD_TUNNEL_RUNTIME_CAPABILITY
        ]
      }
    )
    const timeout = setTimeout(
      () =>
        fail(new PortForwardTunnelError('tunnel_failed', 'The port forward tunnel did not open.')),
      ATTACH_TIMEOUT_MS
    )
    try {
      const opened = await ready.promise
      return {
        client: opened,
        close: () => {
          closed = true
          opened.close(new Error('Port forward closed.'))
          subscription?.close()
        }
      }
    } catch (error) {
      subscription.close()
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

/**
 * One lazily opened host session per environment. A dropped or exhausted session is replaced on
 * the next connection, so forwards outlive VM sleep, reconnects and stream-id exhaustion.
 */
export class EnvironmentPortForwardTunnel {
  private current: Promise<{ client: BrowserNetworkTunnelClient; close: () => void }> | null = null

  constructor(
    readonly environmentId: string,
    private readonly connector: PortForwardTunnelConnector
  ) {}

  /** A local connection never wakes a sleeping VM; it fails until the user reconnects. */
  async open(remotePort: number): Promise<BrowserNetworkTunnelDuplex> {
    const session = await this.session(false)
    return session.client.open({ host: '127.0.0.1', port: remotePort })
  }

  /** Opens the host session without a connection, so failures surface when the forward is added. */
  async warm(wake: boolean): Promise<void> {
    await this.session(wake)
  }

  private async session(
    wake: boolean
  ): Promise<{ client: BrowserNetworkTunnelClient; close: () => void }> {
    const existing = this.current
    if (existing) {
      const session = await existing.catch(() => null)
      if (session && !session.client.streamIdsExhausted && this.current === existing) {
        return session
      }
      if (this.current === existing) {
        session?.close()
        this.current = null
      }
    }
    const attempt = this.connector(
      this.environmentId,
      () => {
        if (this.current === attempt) {
          this.current = null
        }
      },
      { wake }
    )
    this.current = attempt
    attempt.catch(() => {
      if (this.current === attempt) {
        this.current = null
      }
    })
    return attempt
  }

  close(): void {
    const existing = this.current
    this.current = null
    void existing?.then((session) => session.close()).catch(() => {})
  }
}
