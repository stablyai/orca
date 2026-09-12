import { TransportPublicationDrain } from '../../shared/transport-publication-drain'
import {
  SshRelayNetworkTunnelTransport,
  SshNetworkTunnelNotAdmittedError
} from './ssh-relay-network-tunnel-transport'
import type { captureSshNetworkTunnelBinding } from './ssh-relay-network-tunnel-binding'
import type { RelayOwnerResetRequest } from '../../shared/relay-owner-reset-contract'

type Binding = ReturnType<typeof captureSshNetworkTunnelBinding>
type Tunnel = Pick<
  SshRelayNetworkTunnelTransport,
  'fenceForDrain' | 'closeAfterDrain' | 'fail' | 'open'
> &
  Partial<
    Pick<
      SshRelayNetworkTunnelTransport,
      | 'retirementConfirmed'
      | 'resetRetirementRequest'
      | 'assertResetRetirementReady'
      | 'confirmResetRetirement'
    >
  >

export class SshSessionNetworkTunnels {
  private fenced = false
  private readonly tunnels = new Set<Tunnel>()
  private readonly closing = new Map<Tunnel, Promise<void>>()
  private readonly drains = new Map<Tunnel, ReturnType<Tunnel['fenceForDrain']>>()
  private readonly startup = new TransportPublicationDrain(() => {})

  async open(
    binding: Binding,
    options: { signal?: AbortSignal; onFailure?: (error: Error) => void } = {},
    create: (
      options: Parameters<typeof SshRelayNetworkTunnelTransport.create>[0]
    ) => Promise<Tunnel> = SshRelayNetworkTunnelTransport.create
  ): Promise<Tunnel> {
    if (this.fenced) {
      throw new Error('ssh_session_network_tunnel_admission_closed')
    }
    this.startup.assertCurrent()
    binding.assertAdmission()
    const settle = this.startup.trackWrite()
    try {
      const tunnel = await create({
        ...options,
        mux: binding.mux,
        owner: binding.owner,
        assertCurrent: binding.assertCurrent,
        onFailure: (error) => {
          this.startup.fail(error)
          options.onFailure?.(error)
        }
      })
      this.tunnels.add(tunnel)
      if (this.fenced) {
        this.drains.set(tunnel, tunnel.fenceForDrain())
      }
      settle({ ok: true })
      return tunnel
    } catch (error) {
      settle(
        error instanceof SshNetworkTunnelNotAdmittedError
          ? { ok: true }
          : { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
      )
      throw error
    }
  }

  async release(tunnel: Tunnel, signal: AbortSignal): Promise<void> {
    const existing = this.closing.get(tunnel)
    if (existing) {
      return existing
    }
    if (!this.tunnels.has(tunnel)) {
      throw new Error('ssh_session_network_tunnel_not_owned')
    }
    if (this.fenced) {
      await this.drainTunnel(tunnel).drain(signal)
      return
    }
    const completion = Promise.withResolvers<void>()
    this.closing.set(tunnel, completion.promise)
    const settle = this.startup.trackWrite()
    try {
      await tunnel.closeAfterDrain(signal)
      this.tunnels.delete(tunnel)
      this.drains.delete(tunnel)
      settle({ ok: true })
      completion.resolve()
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
      completion.reject(error)
    } finally {
      this.closing.delete(tunnel)
    }
    return completion.promise
  }

  fenceForDrain() {
    this.fenced = true
    for (const tunnel of this.tunnels) {
      if (!this.closing.has(tunnel)) {
        try {
          this.drainTunnel(tunnel)
        } catch (error) {
          this.startup.fail(error instanceof Error ? error : new Error(String(error)))
        }
      }
    }
    const assertDrained = () => {
      this.startup.assertDrained()
      for (const drain of this.drains.values()) {
        drain.assertDrained()
      }
    }
    return {
      assertDrained,
      confirmResetRetirement: (request: RelayOwnerResetRequest) => {
        assertDrained()
        const selected = [...this.tunnels]
        for (const tunnel of selected) {
          if (!tunnel.assertResetRetirementReady || !tunnel.confirmResetRetirement) {
            throw new Error('ssh_session_network_tunnel_reset_proof_unavailable')
          }
          tunnel.assertResetRetirementReady(request)
        }
        for (const tunnel of selected) {
          tunnel.confirmResetRetirement!(request)
        }
        assertDrained()
      },
      drain: async (signal: AbortSignal) => {
        await this.startup.drain(signal)
        const observer = new AbortController()
        try {
          const combined = AbortSignal.any([signal, observer.signal])
          await Promise.all([...this.drains.values()].map((drain) => drain.drain(combined)))
          signal.throwIfAborted()
          assertDrained()
        } finally {
          observer.abort()
        }
      }
    }
  }

  private drainTunnel(tunnel: Tunnel) {
    let drain = this.drains.get(tunnel)
    if (!drain) {
      drain = tunnel.fenceForDrain()
      this.drains.set(tunnel, drain)
    }
    return drain
  }
}
