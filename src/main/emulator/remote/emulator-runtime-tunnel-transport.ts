import { BrowserNetworkTunnelEvent } from '../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type {
  RemoteRuntimeTransportSubscription,
  RemoteRuntimeTransportSubscriptionCallbacks
} from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { BrowserNetworkTunnelClient } from '../../browser/network/tunnels/browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from '../../browser/network/tunnels/browser-network-tunnel-duplex'
import {
  BrowserNetworkTunnelOutboundMemoryBudgetRegistry,
  type BrowserNetworkTunnelOutboundMemoryLease
} from '../../browser/network/tunnels/browser-network-tunnel-outbound-memory-budget'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'

export const EMULATOR_TUNNEL_READY_TIMEOUT_MS = 15_000

const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()

export type EmulatorTunnelSubscribe = (
  callbacks: RemoteRuntimeTransportSubscriptionCallbacks,
  outboundMemory: BrowserNetworkTunnelOutboundMemoryLease
) => Promise<RemoteRuntimeTransportSubscription>

type LiveTunnel = {
  client: Promise<BrowserNetworkTunnelClient>
  close: (error: Error) => void
}

/** One `emulator.tunnel` subscription to a paired runtime, reopened on demand after it drops. */
export class EmulatorRuntimeTunnelTransport {
  private live: LiveTunnel | null = null
  private closed = false

  constructor(
    private readonly memoryKey: string,
    private readonly subscribe: EmulatorTunnelSubscribe
  ) {}

  async open(target: BrowserNetworkTunnelOpen): Promise<BrowserNetworkTunnelDuplex> {
    let client = await this.ensure()
    if (client.streamIdsExhausted) {
      this.drop(new Error('Emulator tunnel stream ids exhausted'))
      client = await this.ensure()
    }
    return client.open(target)
  }

  close(error = new Error('Emulator tunnel closed')): void {
    this.closed = true
    this.drop(error)
  }

  private ensure(): Promise<BrowserNetworkTunnelClient> {
    if (this.closed) {
      return Promise.reject(new Error('Emulator tunnel closed'))
    }
    this.live ??= this.start()
    return this.live.client
  }

  private drop(error: Error): void {
    const live = this.live
    this.live = null
    live?.close(error)
  }

  private start(): LiveTunnel {
    const outboundMemory = outboundMemoryBudgets.acquire(this.memoryKey)
    let subscription: RemoteRuntimeTransportSubscription | null = null
    let client: BrowserNetworkTunnelClient | null = null
    let settle: { resolve: (c: BrowserNetworkTunnelClient) => void; reject: (e: Error) => void }
    let finished = false
    const ready = new Promise<BrowserNetworkTunnelClient>((resolve, reject) => {
      settle = { resolve, reject }
    })
    void ready.catch(() => undefined)
    const live: LiveTunnel = {
      client: ready,
      close: (error) => {
        if (finished) {
          return
        }
        finished = true
        clearTimeout(readyTimer)
        settle.reject(error)
        try {
          client?.close(error)
        } finally {
          try {
            subscription?.close()
          } finally {
            outboundMemory?.release()
          }
        }
      }
    }
    const fail = (error: Error): void => {
      if (this.live === live) {
        this.live = null
      }
      live.close(error)
    }
    // Ready can arrive before the subscribe promise settles; streams need both to send.
    const resolveWhenAttached = (): void => {
      if (!finished && client && subscription) {
        clearTimeout(readyTimer)
        settle.resolve(client)
      }
    }
    const readyTimer = setTimeout(
      () => fail(new Error('Emulator tunnel attach timed out')),
      EMULATOR_TUNNEL_READY_TIMEOUT_MS
    )
    if (!outboundMemory) {
      fail(new Error('Emulator tunnel memory admission failed'))
      return live
    }
    this.subscribe(
      {
        onResponse: (response) => {
          if (finished) {
            return
          }
          if (!response.ok) {
            fail(new Error(response.error.message || response.error.code))
            return
          }
          const event = BrowserNetworkTunnelEvent.safeParse(response.result)
          if (!event.success || event.data.type === 'closed') {
            fail(new Error('Emulator tunnel closed by the runtime'))
            return
          }
          if (client) {
            return
          }
          try {
            client = new BrowserNetworkTunnelClient({
              tunnelGeneration: event.data.tunnelGeneration,
              sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
              outboundMemory,
              flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
              onClosed: (error) => fail(error)
            })
            resolveWhenAttached()
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        },
        onBinary: (bytes) => client?.handleBinary(bytes),
        onError: (error) => fail(error),
        onClose: () => fail(new Error('Emulator tunnel transport closed'))
      },
      outboundMemory
    ).then(
      (opened) => {
        if (finished) {
          opened.close()
          return
        }
        subscription = opened
        resolveWhenAttached()
      },
      (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
    )
    return live
  }
}
