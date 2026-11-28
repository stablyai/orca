import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'

type RetirementAttempt = { repeat: boolean; promise: Promise<void> }

export class DaemonLegacyIdleRetirement {
  private stopped = false
  private readonly pending = new Map<DaemonPtyAdapter, RetirementAttempt>()

  constructor(
    private readonly isLegacy: (adapter: DaemonPtyAdapter) => boolean,
    private readonly spawnPending: () => boolean = () => false
  ) {}

  request(adapter: DaemonPtyAdapter): Promise<void> {
    if (this.stopped || !this.isLegacy(adapter)) {
      return Promise.resolve()
    }
    const pending = this.pending.get(adapter)
    if (pending) {
      pending.repeat = true
      return pending.promise
    }
    if (!this.canRetire(adapter)) {
      return Promise.resolve()
    }
    const attempt = { repeat: false, promise: Promise.resolve() }
    this.pending.set(adapter, attempt)
    attempt.promise = Promise.resolve().then(() => this.retire(adapter, attempt))
    return attempt.promise
  }

  dispose(): void {
    this.stopped = true
  }

  private canRetire(adapter: DaemonPtyAdapter): boolean {
    return (
      !this.stopped &&
      !this.spawnPending() &&
      this.isLegacy(adapter) &&
      adapter.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION &&
      !adapter.isIdleRetirementAdmissionClosed()
    )
  }

  private async retire(adapter: DaemonPtyAdapter, attempt: RetirementAttempt): Promise<void> {
    try {
      while (this.canRetire(adapter)) {
        attempt.repeat = false
        const sessions = await adapter.listSessions()
        if (!this.canRetire(adapter)) {
          return
        }
        if (sessions.length === 0) {
          const result = await adapter.requestIdleRetirement()
          if (result.state !== 'busy') {
            return
          }
        }
        if (!attempt.repeat) {
          return
        }
      }
    } catch {
      // An unreadable inventory cannot prove the host is empty.
    } finally {
      this.pending.delete(adapter)
    }
  }
}
