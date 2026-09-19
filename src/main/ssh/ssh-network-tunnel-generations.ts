import { TransportPublicationDrain } from '../../shared/transport-publication-drain'
import { SshSessionNetworkTunnels } from './ssh-session-network-tunnels'
import type { captureSshNetworkTunnelBinding } from './ssh-relay-network-tunnel-binding'
import type { RelayOwnerResetRequest } from '../../shared/relay-owner-reset-contract'

type Binding = ReturnType<typeof captureSshNetworkTunnelBinding>
type Generation = { binding: Binding; tunnels: SshSessionNetworkTunnels }

/** Reconnect admits a new generation, never proof that a previous generation drained. */
export class SshNetworkTunnelGenerations {
  private active: Generation | undefined
  private fenced = false
  private pendingRetirements = 0
  private readonly retired = new TransportPublicationDrain(() => {})

  constructor(private readonly createCohort = () => new SshSessionNetworkTunnels()) {}

  capture(binding: Binding): SshSessionNetworkTunnels {
    if (this.fenced) {
      throw new Error('ssh_network_tunnel_generations_fenced')
    }
    binding.assertAdmission()
    const active = this.active
    if (active && this.matches(active.binding, binding)) {
      return active.tunnels
    }
    if (this.pendingRetirements >= 16) {
      throw new Error('ssh_network_tunnel_retirement_capacity')
    }
    if (active) {
      this.retire(active)
    }
    const tunnels = this.createCohort()
    this.active = { binding, tunnels }
    return tunnels
  }

  fenceForDrain() {
    this.fenced = true
    const active = this.active?.tunnels.fenceForDrain()
    const assertDrained = () => {
      this.retired.assertDrained()
      active?.assertDrained()
    }
    return {
      assertDrained,
      confirmResetRetirement: (request: RelayOwnerResetRequest) => {
        assertDrained()
        active?.confirmResetRetirement(request)
        assertDrained()
      },
      drain: async (signal: AbortSignal) => {
        const observation = new AbortController()
        const combined = AbortSignal.any([signal, observation.signal])
        try {
          await Promise.all([this.retired.drain(combined), active?.drain(combined)])
          signal.throwIfAborted()
          assertDrained()
        } finally {
          observation.abort()
        }
      }
    }
  }

  private retire(generation: Generation): void {
    const settle = this.retired.trackWrite()
    this.pendingRetirements++
    const finish = (error?: unknown) => {
      this.pendingRetirements--
      settle(
        error === undefined
          ? { ok: true }
          : {
              ok: false,
              error: error instanceof Error ? error : new Error(String(error))
            }
      )
    }
    try {
      const drain = generation.tunnels.fenceForDrain()
      void drain.drain(new AbortController().signal).then(() => {
        try {
          drain.assertDrained()
          finish()
        } catch (error) {
          finish(error)
        }
      }, finish)
    } catch (error) {
      finish(error)
    }
  }

  private matches(left: Binding, right: Binding): boolean {
    return (
      left.mux === right.mux &&
      left.connection === right.connection &&
      left.providerGeneration === right.providerGeneration &&
      left.owner.clientInstanceId === right.owner.clientInstanceId &&
      left.owner.clientGeneration === right.owner.clientGeneration &&
      left.owner.ownerGeneration === right.owner.ownerGeneration &&
      left.owner.ownerLease === right.owner.ownerLease
    )
  }
}
