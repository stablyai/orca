import { PTY_INCARNATION_ADDRESSED_SHUTDOWN_VERSION } from '../../shared/pty-incarnation'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export class SshIncarnationShutdownCapability {
  private probe: Promise<boolean> | null = null

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async supports(opts: { deadlineMs?: number } = {}): Promise<boolean> {
    const probe =
      this.probe ??
      this.mux
        .request(
          'pty.getCapabilities',
          undefined,
          opts.deadlineMs === undefined
            ? undefined
            : { timeoutMs: Math.max(1, opts.deadlineMs - Date.now()) }
        )
        .then(
          (result) =>
            (result as { incarnationAddressedShutdownVersion?: unknown })
              .incarnationAddressedShutdownVersion === PTY_INCARNATION_ADDRESSED_SHUTDOWN_VERSION
        )
    // Why: relay upgrades replace the connection/provider, so a negative result is stable here.
    this.probe = probe
    try {
      return await probe
    } catch {
      if (this.probe === probe) {
        this.probe = null
      }
      return false
    }
  }
}
