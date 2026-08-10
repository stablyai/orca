import { supportsGitStagedDiscardOperation } from '../../shared/git-staged-discard-operation'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

const SSH_GIT_CAPABILITY_PROBE_TIMEOUT_MS = 5_000

export class SshGitStagedDiscardCapability {
  private probe: Promise<boolean> | null = null

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async supports(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.probe ?? this.probeOwner()
    this.probe = probe
    let supported: boolean
    try {
      supported = await waitForSshCapabilityProbe(probe, options.signal)
    } catch {
      return false
    }
    if (!supported && this.probe === probe) {
      // Why: a reconnected session may deploy a newer relay in place.
      this.probe = null
    }
    return supported
  }

  private async probeOwner(): Promise<boolean> {
    try {
      return supportsGitStagedDiscardOperation(
        await this.mux.request('git.getCapabilities', undefined, {
          timeoutMs: SSH_GIT_CAPABILITY_PROBE_TIMEOUT_MS
        })
      )
    } catch {
      return false
    }
  }
}
