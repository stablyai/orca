import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { proveSshAgentSessionClaimCapability } from './ssh-agent-session-claim-validation'
import { sshSupportsAgentSessionCreateOperations } from './ssh-agent-session-create-operation'
import { sshEchoesLaunchTokens } from './ssh-launch-token-echo-capability'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

export class SshAgentSessionCapabilities {
  private claimProbe: Promise<void> | null = null
  private claimSupported = false
  private createOperationProbe: Promise<boolean> | null = null
  private launchTokenEchoProbe: Promise<boolean> | null = null
  private launchTokenEchoSupported = false

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async supportsClaims(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.claimProbe ?? proveSshAgentSessionClaimCapability(this.mux)
    this.claimProbe = probe
    try {
      await waitForSshCapabilityProbe(probe, options.signal)
      this.claimSupported = true
      return true
    } catch (error) {
      if (
        !options.signal?.aborted &&
        this.claimProbe === probe &&
        (error as { capabilityProbeTransportFailure?: unknown }).capabilityProbeTransportFailure ===
          true
      ) {
        this.claimProbe = null
        this.claimSupported = false
      }
      return false
    }
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
      // Why: a transport failure is unknown and may recover on this connection.
      if (!options.signal?.aborted && this.createOperationProbe === probe) {
        this.createOperationProbe = null
      }
      return false
    }
    return supported
  }

  async supportsLaunchTokenEcho(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.launchTokenEchoProbe ?? sshEchoesLaunchTokens(this.mux)
    this.launchTokenEchoProbe = probe
    let supported: boolean
    try {
      supported = await waitForSshCapabilityProbe(probe, options.signal)
    } catch {
      // Why: a transport failure is unknown and may recover on this connection.
      if (!options.signal?.aborted && this.launchTokenEchoProbe === probe) {
        this.launchTokenEchoProbe = null
      }
      return false
    }
    this.launchTokenEchoSupported = supported
    return supported
  }

  /** Sync read of the last probe: a re-list cannot await, and an unprobed or old
   *  relay must never let a missing launchToken count as absence proof. */
  providesLaunchTokenListings(): boolean {
    return this.launchTokenEchoSupported
  }
}
