import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { proveSshAgentSessionClaimCapability } from './ssh-agent-session-claim-validation'
import { sshSupportsAgentSessionCreateOperations } from './ssh-agent-session-create-operation'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

export class SshAgentSessionCapabilities {
  private claimProbe: Promise<void> | null = null
  private claimSupported = false
  private createOperationProbe: Promise<boolean> | null = null
  private incarnationFenceProbe: Promise<boolean> | null = null

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async supportsClaims(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.claimProbe ?? proveSshAgentSessionClaimCapability(this.mux)
    this.claimProbe = probe
    try {
      await waitForSshCapabilityProbe(probe, options.signal)
      this.claimSupported = true
      return true
    } catch {
      if (!options.signal?.aborted && this.claimProbe === probe) {
        // Why: negative physical probes must follow a relay upgraded on this connection.
        this.claimProbe = null
        this.claimSupported = false
      }
      return false
    }
  }

  async supportsIncarnationFence(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe =
      this.incarnationFenceProbe ??
      this.mux
        .request('pty.getCapabilities', undefined, { signal: options.signal, timeoutMs: 5_000 })
        .then((value) => {
          const version = (value as { incarnationFenceVersion?: unknown })?.incarnationFenceVersion
          return typeof version === 'number' && version >= 1
        })
        .catch(() => false)
    this.incarnationFenceProbe = probe
    const supported = await probe
    // Capability probes can fail transiently while an SSH relay is reconnecting;
    // never let one negative result disable incarnation fencing for this provider's lifetime.
    if (!supported && this.incarnationFenceProbe === probe) {
      this.incarnationFenceProbe = null
    }
    return supported
  }

  providesOwnerListings(): boolean {
    return this.claimSupported
  }

  async supportsCreateOperations(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.createOperationProbe ?? sshSupportsAgentSessionCreateOperations(this.mux)
    this.createOperationProbe = probe
    let supported: boolean
    try {
      supported = await waitForSshCapabilityProbe(probe, options.signal)
    } catch {
      // Why: one canceled waiter must not cancel or evict the shared physical probe used by peers.
      return false
    }
    if (!supported && this.createOperationProbe === probe) {
      // Why: negative capability results must follow a relay upgraded on the same connection.
      this.createOperationProbe = null
    }
    return supported
  }
}
