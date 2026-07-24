import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

export class SshPtyReviveCapabilities {
  private probe: Promise<boolean> | null = null

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async supportsTypedRevive(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.probe ?? this.probeTypedRevive()
    this.probe = probe
    try {
      const supported = await waitForSshCapabilityProbe(probe, options.signal)
      if (!supported && this.probe === probe) {
        // Why: a relay can be upgraded without replacing the current SSH mux.
        this.probe = null
      }
      return supported
    } catch (error) {
      if (!options.signal?.aborted && this.probe === probe) {
        this.probe = null
      }
      if (isPtyCapabilityMethodUnavailable(error)) {
        return false
      }
      throw error
    }
  }

  private async probeTypedRevive(): Promise<boolean> {
    const capabilities = await this.mux.request('pty.getCapabilities')
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      return false
    }
    const value = capabilities as Record<string, unknown>
    return value.ptyPersistenceEnvelopeVersion === 2 && value.ptyReviveOutcomeVersion === 1
  }
}

function isPtyCapabilityMethodUnavailable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === -32601) {
    return true
  }
  return false
}
