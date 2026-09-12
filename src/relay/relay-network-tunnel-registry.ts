import { connect } from 'node:net'
import { BrowserNetworkTunnelSession } from '../main/browser/browser-network-tunnel-session'
import { BrowserNetworkTunnelResourceBudget } from '../main/browser/browser-network-tunnel-resource-budget'
import type { BrowserNetworkTunnelSessionOptions } from '../main/browser/browser-network-tunnel-stream-state'
import {
  decodeRelayNetworkTunnelFrame,
  encodeRelayNetworkTunnelFrame,
  parseRelayNetworkTunnelHandle,
  parseRelayNetworkTunnelOwner,
  RELAY_NETWORK_TUNNEL_FRAME_METHOD,
  type RelayNetworkTunnelHandle
} from '../shared/relay-network-tunnel-contract'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  captureRelayNetworkTunnelOwner,
  type RelayNetworkTunnelOwnerSource
} from './relay-network-tunnel-owner'
import { RelayProducerPublicationDrain } from './relay-producer-publication-drain'

type TunnelEntry = {
  handle: RelayNetworkTunnelHandle
  owner: ReturnType<typeof captureRelayNetworkTunnelOwner>
  publication: RelayProducerPublicationDrain
  session: BrowserNetworkTunnelSession
  drain?: ReturnType<BrowserNetworkTunnelSession['fenceForDrain']>
  published: boolean
  retiring: boolean
  removeCapacity?: () => void
}

type RegistryDrain = {
  drain: (signal: AbortSignal) => Promise<void>
  assertDrained: () => void
  seal: () => void
}

export class RelayNetworkTunnelRegistry {
  get admissionOpen(): boolean {
    return !this.fenced && !this.failure
  }

  get hasTunnels(): boolean {
    return this.entries.size > 0
  }

  private readonly entries = new Map<number, TunnelEntry>()
  private readonly budget = new BrowserNetworkTunnelResourceBudget()
  private nextGeneration = 1
  private fenced = false
  private sealed = false
  private shutdownDrain: RegistryDrain | undefined
  private failure: Error | undefined
  private readonly removeListeners: (() => void)[]

  constructor(
    private readonly options: {
      dispatcher: RelayDispatcher
      owners: RelayNetworkTunnelOwnerSource
      runtimeIncarnation: string
      ownsEndpoint: () => boolean
      connect?: BrowserNetworkTunnelSessionOptions['connect']
    }
  ) {
    this.removeListeners = [
      options.dispatcher.onClientDetached((id) => {
        for (const entry of this.entries.values()) {
          if (entry.owner.clientId === id) {
            this.failEntry(entry, new Error('relay_network_tunnel_transport_unverifiable'))
          }
        }
      }),
      options.dispatcher.onDisposed(() => this.dispose())
    ]
  }

  open(raw: Record<string, unknown>, context: RequestContext): RelayNetworkTunnelHandle {
    this.assertHealthy()
    if (this.fenced || this.entries.size >= 16 || this.nextGeneration > 0xffff_ffff) {
      throw new Error('relay_network_tunnel_admission_closed')
    }
    if (!context.onResponseSettled) {
      throw new Error('relay_network_tunnel_response_settlement_required')
    }
    const request = parseRelayNetworkTunnelOwner(raw)
    const owner = captureRelayNetworkTunnelOwner(request, context, this.options)
    const handle = Object.freeze({ ...request, tunnelGeneration: this.nextGeneration++ })
    let entry: TunnelEntry | undefined
    const publication = new RelayProducerPublicationDrain(
      this.options.dispatcher,
      owner.clientId,
      owner.transportGeneration,
      owner.assertCurrent,
      (error) => {
        if (entry) {
          this.failEntry(entry, error)
        }
      }
    )
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: handle.tunnelGeneration,
      connect: (target) => {
        owner.assertCurrent()
        return this.options.connect?.(target) ?? connect({ ...target, allowHalfOpen: true })
      },
      claimAggregateRetainedBytes: (bytes) => this.budget.claimRetainedBytes(bytes),
      sendBinary: (bytes) =>
        publication.publish(
          RELAY_NETWORK_TUNNEL_FRAME_METHOD,
          encodeRelayNetworkTunnelFrame(handle, bytes)
        ),
      onClose: () => {
        if (entry && !entry.retiring) {
          this.failEntry(entry, new Error('relay_network_tunnel_closed_unproven'))
        }
      }
    })
    entry = {
      handle,
      owner,
      publication,
      session,
      published: false,
      retiring: false
    }
    const admitted = entry
    entry.removeCapacity =
      this.options.dispatcher.onClientCapacity(owner.clientId, () => {
        try {
          owner.assertCurrent()
          this.options.dispatcher.assertSettledProducerTransport(
            owner.clientId,
            owner.transportGeneration
          )
        } catch (error) {
          this.failEntry(admitted, error instanceof Error ? error : new Error(String(error)))
        }
      }) ?? undefined
    this.entries.set(handle.tunnelGeneration, entry)
    const settle = publication.trackWrite()
    try {
      context.onResponseSettled((result) => {
        settle(result)
        if (!result.ok) {
          this.failEntry(admitted, result.error)
          return
        }
        try {
          owner.assertCurrent()
          admitted.published = true
        } catch (error) {
          this.failEntry(admitted, error instanceof Error ? error : new Error(String(error)))
        }
      })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      settle({ ok: false, error: failure })
      this.failEntry(entry, failure)
      throw error
    }
    return handle
  }

  handleFrame(raw: Record<string, unknown>, context: RequestContext): void {
    if (this.sealed) {
      throw new Error('relay_network_tunnel_shutdown_sealed')
    }
    const handle = parseRelayNetworkTunnelHandle(raw)
    const entry = this.requireEntry(handle, context)
    if (!entry.published) {
      throw new Error('relay_network_tunnel_open_publication_pending')
    }
    const { bytes } = decodeRelayNetworkTunnelFrame(raw)
    entry.session.handleBinary(bytes)
  }

  async close(raw: Record<string, unknown>, context: RequestContext): Promise<void> {
    const handle = parseRelayNetworkTunnelHandle(raw)
    const entry = this.requireEntry(handle, context)
    const drain = this.drainEntry(entry)
    await drain.drain(context.signal ?? new AbortController().signal)
    this.requireEntry(handle, context)
    drain.assertDrained()
    if (!this.fenced) {
      entry.retiring = true
      entry.removeCapacity?.()
      entry.session.close()
      this.entries.delete(handle.tunnelGeneration)
    }
  }

  fenceForDrain(): RegistryDrain {
    if (this.shutdownDrain) {
      return this.shutdownDrain
    }
    this.fenced = true
    const entries = [...this.entries.values()].filter((entry) => !entry.retiring)
    const drains = entries.map((entry) => this.drainEntry(entry))
    this.assertHealthy()
    const assertDrained = () => {
      this.assertHealthy()
      for (const entry of entries) {
        if (this.sealed) {
          entry.publication.assertDrained()
        } else {
          entry.drain!.assertDrained()
        }
      }
    }
    return (this.shutdownDrain = {
      assertDrained,
      seal: () => {
        assertDrained()
        this.sealed = true
        for (const entry of entries) {
          entry.retiring = true
          entry.removeCapacity?.()
          entry.session.close()
        }
      },
      drain: async (signal: AbortSignal) => {
        this.assertHealthy()
        if (this.sealed) {
          signal.throwIfAborted()
          assertDrained()
          return
        }
        const observation = new AbortController()
        const combined = AbortSignal.any([signal, observation.signal])
        try {
          await Promise.all(drains.map((drain) => drain.drain(combined)))
          signal.throwIfAborted()
          assertDrained()
        } finally {
          observation.abort()
        }
      }
    })
  }

  dispose(): void {
    this.fenced = true
    for (const remove of this.removeListeners) {
      remove()
    }
    for (const entry of this.entries.values()) {
      this.failEntry(entry, new Error('relay_network_tunnel_registry_disposed'))
    }
    this.failure ??= new Error('relay_network_tunnel_registry_disposed')
  }

  private drainEntry(entry: TunnelEntry) {
    return (entry.drain ??= entry.session.fenceForDrain(entry.publication))
  }

  private requireEntry(handle: RelayNetworkTunnelHandle, context: RequestContext): TunnelEntry {
    const entry = this.entries.get(handle.tunnelGeneration)
    if (
      !entry ||
      entry.retiring ||
      entry.handle.runtimeIncarnation !== handle.runtimeIncarnation ||
      entry.handle.ownerGeneration !== handle.ownerGeneration ||
      entry.handle.ownerLease !== handle.ownerLease
    ) {
      throw new Error('relay_network_tunnel_handle_mismatch')
    }
    entry.owner.assertIncoming(context)
    return entry
  }

  private assertHealthy(): void {
    if (this.failure) {
      throw this.failure
    }
  }

  private failEntry(entry: TunnelEntry, error: Error): void {
    this.failure ??= error
    entry.retiring = true
    entry.removeCapacity?.()
    entry.publication.fail(error)
    entry.session.close()
  }
}
