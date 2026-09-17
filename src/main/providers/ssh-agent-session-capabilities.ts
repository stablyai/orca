import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { proveSshAgentSessionClaimCapability } from './ssh-agent-session-claim-validation'
import { sshSupportsAgentSessionCreateOperations } from './ssh-agent-session-create-operation'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

export class SshAgentSessionCapabilities {
  private claimProbe: Promise<void> | null = null
  private claimSupported = false
  private createOperationProbe: Promise<boolean> | null = null
  private foregroundEvidenceProbe: Promise<boolean> | null = null
  private verifiedDiscoveryProbe: Promise<boolean> | null = null
  private freshClaimProbe: Promise<boolean> | null = null

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

  async supportsFreshClaims(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe =
      this.freshClaimProbe ??
      this.mux
        .request('pty.getCapabilities', undefined, {
          signal: options.signal,
          timeoutMs: 5_000
        })
        .then((value) => {
          if (typeof value !== 'object' || value === null) {
            return false
          }
          return (
            'agentSessionFreshClaimVersion' in value && value.agentSessionFreshClaimVersion === 1
          )
        })
        .catch(() => false)
    this.freshClaimProbe = probe
    try {
      const supported = await waitForSshCapabilityProbe(probe, options.signal)
      if (!supported && this.freshClaimProbe === probe) {
        this.freshClaimProbe = null
      }
      return supported
    } catch {
      if (!options.signal?.aborted && this.freshClaimProbe === probe) {
        this.freshClaimProbe = null
      }
      return false
    }
  }

  /** Whether this relay understands the opt-in no-evidence inventory projection. */
  async supportsForegroundProcessEvidence(
    options: { signal?: AbortSignal } = {}
  ): Promise<boolean> {
    const probe =
      this.foregroundEvidenceProbe ??
      this.mux
        .request('pty.getCapabilities', undefined, {
          signal: options.signal,
          timeoutMs: 5_000
        })
        .then((value) => {
          const capabilities = value as { foregroundProcessEvidenceVersion?: unknown }
          return capabilities.foregroundProcessEvidenceVersion === 1
        })
        .catch(() => false)
    this.foregroundEvidenceProbe = probe
    try {
      const supported = await waitForSshCapabilityProbe(probe, options.signal)
      if (!supported && this.foregroundEvidenceProbe === probe) {
        this.foregroundEvidenceProbe = null
      }
      return supported
    } catch {
      if (!options.signal?.aborted && this.foregroundEvidenceProbe === probe) {
        this.foregroundEvidenceProbe = null
      }
      return false
    }
  }

  async supportsVerifiedAgentDiscoveries(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe =
      this.verifiedDiscoveryProbe ??
      this.mux
        .request('pty.getCapabilities', undefined, {
          signal: options.signal,
          timeoutMs: 5_000
        })
        .then((value) => {
          return (
            typeof value === 'object' &&
            value !== null &&
            'verifiedAgentDiscoveryVersion' in value &&
            value.verifiedAgentDiscoveryVersion === 1
          )
        })
        .catch(() => false)
    this.verifiedDiscoveryProbe = probe
    try {
      const supported = await waitForSshCapabilityProbe(probe, options.signal)
      if (!supported && this.verifiedDiscoveryProbe === probe) {
        this.verifiedDiscoveryProbe = null
      }
      return supported
    } catch {
      if (!options.signal?.aborted && this.verifiedDiscoveryProbe === probe) {
        this.verifiedDiscoveryProbe = null
      }
      return false
    }
  }
}
