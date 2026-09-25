import {
  BrowserNetworkTunnelAttachParams,
  BrowserNetworkTunnelEvent,
  type BrowserHostLeaseAuthority,
  type BrowserNetworkExecutionHost
} from '../../../src/shared/browser-client-host-protocol'
import { BrowserNetworkTunnelClient } from '../../../src/shared/browser-network-tunnel-client'
import type { BrowserNetworkTunnelClientOptions } from '../../../src/shared/browser-network-tunnel-client'
import type {
  BrowserNetworkTunnelClientSocket,
  BrowserNetworkTunnelClientSocketCallbacks
} from '../../../src/shared/browser-network-tunnel-client-socket'
import type { RpcBinaryChannelOptions, RpcBinaryClient } from './rpc-binary-channel'
import type { RpcResponse } from './types'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'

export type MobileBrowserTunnelConnectionOptions<Socket extends BrowserNetworkTunnelClientSocket> =
  {
    // The lease owner retains one connection per execution route, across all of its pages.
    attach: BrowserHostLeaseAuthority & { executionHost: BrowserNetworkExecutionHost }
    connect: (channel: RpcBinaryChannelOptions) => RpcBinaryClient
    createSocket: (callbacks: BrowserNetworkTunnelClientSocketCallbacks) => Socket
    outboundMemory: NonNullable<BrowserNetworkTunnelClientOptions['outboundMemory']>
    minimumTunnelGeneration: number
    timeoutMs?: number
    signal?: AbortSignal
  }

/** One incarnation only: the lease owner must revalidate authority before replacing a lost route. */
export class MobileBrowserTunnelConnection<Socket extends BrowserNetworkTunnelClientSocket> {
  readonly ready: Promise<BrowserNetworkTunnelClient<Socket> | null>
  private client: RpcBinaryClient | null = null
  private tunnel: BrowserNetworkTunnelClient<Socket> | null = null
  private closed = false
  private unsubscribe = () => {}
  private unlisten = () => {}
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolveReady!: (tunnel: BrowserNetworkTunnelClient<Socket> | null) => void
  private rejectReady!: (error: Error) => void
  private readonly abort = () => this.close(new Error('Browser tunnel cancelled'))

  constructor(private readonly options: MobileBrowserTunnelConnectionOptions<Socket>) {
    const attach = BrowserNetworkTunnelAttachParams.parse(options.attach)
    if (
      !Number.isInteger(options.minimumTunnelGeneration) ||
      options.minimumTunnelGeneration < 0 ||
      options.minimumTunnelGeneration > 0xffff_ffff
    ) {
      throw new Error('Invalid minimum browser tunnel generation')
    }
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    if (options.signal?.aborted) {
      this.abort()
      return
    }
    options.signal?.addEventListener('abort', this.abort, { once: true })
    try {
      this.client = options.connect({
        claimQueuedBytes: options.outboundMemory.claimApplicationBytes,
        clientCapabilities: [
          BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
          BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
          BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
        ],
        onBinary: (bytes) => {
          if (this.closed) {
            return
          }
          if (!this.tunnel) {
            this.close(new Error('Browser tunnel bytes arrived before readiness'))
          } else {
            this.tunnel.handleBinary(bytes)
          }
        }
      })
      if (this.closed) {
        this.client.close()
        return
      }
      this.unlisten = this.client.onStateChange((state) => {
        if (state === 'auth-failed' || state === 'disconnected' || state === 'reconnecting') {
          this.close(new Error(`Browser tunnel transport ${state}`))
        }
      })
      if (this.closed) {
        this.unlisten()
        return
      }
      this.timer = setTimeout(
        () => this.close(new Error('Browser tunnel attach timed out')),
        options.timeoutMs ?? 15_000
      )
      this.unsubscribe = this.client.subscribe('network.browserTunnel', attach, () => {}, {
        onResponse: (response) => this.handleResponse(response, attach.authorityRuntimeId)
      })
      if (this.closed) {
        this.unsubscribe()
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  close(error = new Error('Browser tunnel connection closed')): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.options.signal?.removeEventListener('abort', this.abort)
    this.rejectReady(error)
    this.unlisten()
    this.unsubscribe()
    try {
      this.tunnel?.close(error)
    } finally {
      this.tunnel = null
      this.client?.close()
    }
  }

  private handleResponse(response: RpcResponse, runtimeId: string): void {
    if (this.closed) {
      return
    }
    if (!response.ok) {
      if (response.error.code === 'forbidden' || response.error.code === 'method_not_found') {
        this.resolveReady(null)
      }
      this.close(new Error(`${response.error.code}: ${response.error.message}`))
      return
    }
    const event = BrowserNetworkTunnelEvent.safeParse(response.result)
    if (!event.success || response._meta?.runtimeId !== runtimeId) {
      this.close(new Error('Invalid browser tunnel response'))
      return
    }
    if (event.data.type === 'closed') {
      this.close(new Error('Browser tunnel closed by execution host'))
      return
    }
    if (this.tunnel || event.data.tunnelGeneration <= this.options.minimumTunnelGeneration) {
      this.close(new Error('Browser tunnel generation did not advance'))
      return
    }
    this.tunnel = new BrowserNetworkTunnelClient(
      {
        tunnelGeneration: event.data.tunnelGeneration,
        sendBinary: (bytes) => this.client?.sendBinary(new Uint8Array(bytes)) ?? false,
        outboundMemory: this.options.outboundMemory,
        onClosed: (error) => this.close(error)
      },
      this.options.createSocket
    )
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.resolveReady(this.tunnel)
  }
}
