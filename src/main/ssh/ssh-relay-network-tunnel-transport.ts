import { BrowserNetworkTunnelClient } from '../browser/browser-network-tunnel-client'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import {
  decodeRelayNetworkTunnelFrame,
  encodeRelayNetworkTunnelFrame,
  parseRelayNetworkTunnelHandle,
  readRelayNetworkTunnelIncarnation,
  RELAY_NETWORK_TUNNEL_OPEN_METHOD,
  RELAY_NETWORK_TUNNEL_CLOSE_METHOD,
  RELAY_NETWORK_TUNNEL_FRAME_METHOD,
  type RelayNetworkTunnelHandle
} from '../../shared/relay-network-tunnel-contract'
import { TransportPublicationDrain } from '../../shared/transport-publication-drain'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import {
  parseRelayOwnerResetRequest,
  type RelayOwnerResetRequest
} from '../../shared/relay-owner-reset-contract'

type TunnelOptions = {
  mux: SshChannelMultiplexer
  owner: { ownerGeneration: number; ownerLease: string }
  assertCurrent: () => void
  signal?: AbortSignal
  onFailure?: (error: Error) => void
}

export class SshNetworkTunnelNotAdmittedError extends Error {
  constructor(cause: unknown) {
    super(asError(cause).message, { cause })
    this.name = 'SshNetworkTunnelNotAdmittedError'
  }
}

export class SshRelayNetworkTunnelTransport {
  private readonly publication: TransportPublicationDrain
  private readonly removeListeners: (() => void)[] = []
  private handle: RelayNetworkTunnelHandle | undefined
  private client: BrowserNetworkTunnelClient | undefined
  private failure: Error | undefined
  private retired = false
  private preparedReset: RelayOwnerResetRequest | undefined
  private drainHandle: ReturnType<BrowserNetworkTunnelClient['fenceForDrain']> | undefined

  get retirementConfirmed(): boolean {
    return this.retired
  }

  get resetRetirementRequest(): RelayOwnerResetRequest | undefined {
    return this.preparedReset
  }

  assertResetRetirementReady(request: RelayOwnerResetRequest): void {
    const expected = parseRelayOwnerResetRequest(request)
    this.options.mux.assertRelayResetAcknowledgmentDrained(expected)
    if (
      !this.handle ||
      this.retired ||
      this.preparedReset ||
      this.handle.runtimeIncarnation !== expected.runtimeIncarnation ||
      this.handle.ownerGeneration !== expected.ownerGeneration ||
      this.handle.ownerLease !== expected.ownerLease
    ) {
      throw new Error('ssh_network_tunnel_reset_identity_mismatch')
    }
    if (!this.drainHandle) {
      throw new Error('ssh_network_tunnel_reset_not_drained')
    }
    this.drainHandle.assertDrained()
  }

  confirmResetRetirement(request: RelayOwnerResetRequest): void {
    const expected = parseRelayOwnerResetRequest(request)
    this.assertResetRetirementReady(expected)
    // Reset preparation is not the ordinary per-tunnel Close receipt.
    this.preparedReset = expected
    this.removeSubscriptions()
    this.client?.close(new Error('ssh_network_tunnel_reset_prepared'))
  }

  private get drainPreserved(): boolean {
    return this.retired || this.preparedReset !== undefined
  }

  private constructor(private readonly options: TunnelOptions) {
    const channel = options.mux.getSourceChannel()
    this.publication = new TransportPublicationDrain(
      () => {
        options.assertCurrent()
        options.mux.assertWriteSettlement()
        if (options.mux.getSourceChannel() !== channel) {
          throw new Error('ssh_network_tunnel_transport_changed')
        }
      },
      (error) => this.fail(error)
    )
    this.removeListeners.push(
      options.mux.onDispose(() => this.fail(new Error('ssh_network_tunnel_transport_unverifiable')))
    )
    this.removeListeners.push(
      options.mux.onNotificationByMethod(RELAY_NETWORK_TUNNEL_FRAME_METHOD, (params) =>
        this.receive(params)
      )
    )
  }

  static async create(options: TunnelOptions): Promise<SshRelayNetworkTunnelTransport> {
    const captured = { ...options, owner: Object.freeze({ ...options.owner }) }
    let runtimeIncarnation: string
    try {
      captured.assertCurrent()
      captured.mux.assertWriteSettlement()
      const status = await captured.mux.request('relay.status', undefined, {
        signal: captured.signal
      })
      captured.assertCurrent()
      captured.mux.assertWriteSettlement()
      runtimeIncarnation = readRelayNetworkTunnelIncarnation(status)
    } catch (error) {
      throw new SshNetworkTunnelNotAdmittedError(error)
    }
    const transport = new SshRelayNetworkTunnelTransport(captured)
    try {
      const owner = {
        version: 1 as const,
        ...captured.owner,
        runtimeIncarnation
      }
      await captured.mux.request(RELAY_NETWORK_TUNNEL_OPEN_METHOD, owner, {
        signal: captured.signal,
        beforeResolve: (value) => {
          transport.publication.assertCurrent()
          const handle = parseRelayNetworkTunnelHandle(value)
          if (
            handle.ownerGeneration !== owner.ownerGeneration ||
            handle.ownerLease !== owner.ownerLease ||
            handle.runtimeIncarnation !== owner.runtimeIncarnation
          ) {
            throw new Error('ssh_network_tunnel_open_identity_mismatch')
          }
          transport.handle = handle
          transport.client = new BrowserNetworkTunnelClient({
            tunnelGeneration: handle.tunnelGeneration,
            sendBinary: (bytes) => transport.send(bytes),
            onClosed: (error) => transport.fail(error)
          })
        }
      })
      transport.publication.assertCurrent()
      return transport
    } catch (error) {
      transport.fail(asError(error))
      throw error
    }
  }

  open(target: BrowserNetworkTunnelOpen) {
    try {
      this.publication.assertCurrent()
      if (this.drainPreserved || !this.client) {
        throw new Error('ssh_network_tunnel_not_ready')
      }
      return this.client.open(target)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  fenceForDrain() {
    if (this.drainPreserved && this.drainHandle) {
      return this.drainHandle
    }
    this.publication.assertCurrent()
    if (!this.client || this.retired) {
      throw new Error('ssh_network_tunnel_not_ready')
    }
    if (!this.drainHandle) {
      const live = this.client.fenceForDrain(this.publication)
      this.drainHandle = {
        assertDrained: () => {
          if (!this.drainPreserved) {
            live.assertDrained()
          }
        },
        drain: async (signal: AbortSignal) => {
          signal.throwIfAborted()
          if (!this.drainPreserved) {
            try {
              await live.drain(signal)
            } catch (error) {
              if (!this.drainPreserved) {
                throw error
              }
            }
          }
          signal.throwIfAborted()
        }
      }
    }
    return this.drainHandle
  }

  async closeAfterDrain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.preparedReset) {
      throw new Error('ssh_network_tunnel_reset_prepared')
    }
    if (this.retired) {
      return
    }
    const drain = this.fenceForDrain()
    await drain.drain(signal)
    const result = await this.options.mux.request(RELAY_NETWORK_TUNNEL_CLOSE_METHOD, this.handle, {
      signal
    })
    drain.assertDrained()
    if (!result || typeof result !== 'object' || (result as { closed?: unknown }).closed !== true) {
      throw new Error('ssh_network_tunnel_close_unconfirmed')
    }
    this.retired = true
    this.removeSubscriptions()
    this.client?.close(new Error('ssh_network_tunnel_retired'))
  }

  fail(error: Error): void {
    if (this.failure || this.drainPreserved) {
      return
    }
    this.failure = error
    this.publication?.fail(error)
    this.removeSubscriptions()
    this.client?.close(error)
    this.options.onFailure?.(error)
  }

  private send(bytes: Uint8Array<ArrayBufferLike>): boolean {
    const settle = this.publication.trackWrite()
    try {
      this.publication.assertCurrent()
      if (!this.handle || this.drainPreserved) {
        throw new Error('ssh_network_tunnel_not_ready')
      }
      this.options.mux.notifyWithSettlement(
        RELAY_NETWORK_TUNNEL_FRAME_METHOD,
        encodeRelayNetworkTunnelFrame(this.handle, bytes),
        (result) =>
          settle(result.outcome === 'accepted' ? { ok: true } : { ok: false, error: result.error }),
        () => {
          this.publication.assertCurrent()
          return !this.drainPreserved
        }
      )
      return !this.failure
    } catch (error) {
      settle({ ok: false, error: asError(error) })
      return false
    }
  }

  private receive(params: Record<string, unknown>): void {
    if (this.failure || this.drainPreserved) {
      return
    }
    try {
      this.publication.assertCurrent()
      const handle = parseRelayNetworkTunnelHandle(params)
      if (!this.handle || handle.tunnelGeneration !== this.handle.tunnelGeneration) {
        return
      }
      if (
        handle.runtimeIncarnation !== this.handle.runtimeIncarnation ||
        handle.ownerGeneration !== this.handle.ownerGeneration ||
        handle.ownerLease !== this.handle.ownerLease
      ) {
        throw new Error('ssh_network_tunnel_frame_identity_mismatch')
      }
      this.client!.handleBinary(decodeRelayNetworkTunnelFrame(params).bytes)
    } catch (error) {
      this.fail(asError(error))
    }
  }

  private removeSubscriptions(): void {
    for (const remove of this.removeListeners.splice(0)) {
      remove()
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
