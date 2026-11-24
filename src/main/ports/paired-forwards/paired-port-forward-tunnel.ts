import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import { PairedRuntimeBrowserNetworkTransport } from '../../browser/network/execution-routes/paired-runtime-browser-network-transport'
import type { BrowserNetworkTunnelClient } from '../../browser/network/tunnels/browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from '../../browser/network/tunnels/browser-network-tunnel-duplex'
import {
  BrowserNetworkTunnelOutboundMemoryBudgetRegistry,
  type BrowserNetworkTunnelOutboundMemoryLease
} from '../../browser/network/tunnels/browser-network-tunnel-outbound-memory-budget'

const ATTACH_TIMEOUT_MS = 15_000
const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()

/** One paired server's forward tunnel: dialed on the first connection, redialed after it drops. */
export class PairedPortForwardTunnel {
  private transport: PairedRuntimeBrowserNetworkTransport | null = null
  private connecting: Promise<BrowserNetworkTunnelClient> | null = null
  private outboundMemory: BrowserNetworkTunnelOutboundMemoryLease | null = null
  // Advanced by every reset, so a startup that began before one never claims the tunnel.
  private generation = 0
  private disposed = false

  constructor(
    readonly environmentId: string,
    private readonly resolveConnection: () => Promise<PairedRuntimeConnection>
  ) {}

  isDisposed(): boolean {
    return this.disposed
  }

  async open(target: BrowserNetworkTunnelOpen): Promise<BrowserNetworkTunnelDuplex> {
    let tunnel = await this.connect()
    if (tunnel.streamIdsExhausted) {
      this.reset(new Error('Port forward stream IDs exhausted'))
      tunnel = await this.connect()
    }
    return tunnel.open(target)
  }

  /** Drops the live tunnel; forwards keep listening and redial on their next connection. */
  reset(error = new Error('Port forward tunnel reset')): void {
    const transport = this.transport
    this.generation += 1
    this.transport = null
    this.connecting = null
    transport?.close(error)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.reset(new Error('Port forward tunnel closed'))
    this.outboundMemory?.release()
    this.outboundMemory = null
  }

  private connect(): Promise<BrowserNetworkTunnelClient> {
    if (this.disposed) {
      return Promise.reject(new Error('Port forward tunnel closed'))
    }
    const tunnel = this.transport?.tunnel
    if (tunnel) {
      return Promise.resolve(tunnel)
    }
    if (!this.connecting) {
      const connecting = this.startTransport()
      this.connecting = connecting
      void connecting.then(
        () => this.forgetConnecting(connecting),
        () => this.forgetConnecting(connecting)
      )
    }
    return this.connecting
  }

  private forgetConnecting(connecting: Promise<BrowserNetworkTunnelClient>): void {
    if (this.connecting === connecting) {
      this.connecting = null
    }
  }

  private async startTransport(): Promise<BrowserNetworkTunnelClient> {
    const generation = this.generation
    const connection = await this.resolveConnection()
    if (this.disposed || this.generation !== generation) {
      throw new Error('Port forward tunnel was reset during startup')
    }
    this.outboundMemory ??= outboundMemoryBudgets.acquire(this.environmentId)
    if (!this.outboundMemory) {
      throw new Error('Port forward outbound memory admission failed')
    }
    const transport = new PairedRuntimeBrowserNetworkTransport({
      connection,
      attach: {
        method: 'network.portForward',
        params: {},
        clientCapabilities: [NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY]
      },
      timeoutMs: ATTACH_TIMEOUT_MS,
      outboundMemory: this.outboundMemory,
      // Each attach is its own socket, so frames from an earlier tunnel never reach this one.
      minimumTunnelGeneration: 0,
      onReady: () => {},
      onFailure: (failed) => {
        if (this.transport === failed) {
          this.transport = null
        }
      }
    })
    this.transport = transport
    const tunnel = await transport.start()
    if (this.disposed || this.transport !== transport || this.generation !== generation) {
      transport.close(new Error('Port forward tunnel superseded'))
      throw new Error('Port forward tunnel closed during startup')
    }
    return tunnel
  }
}
