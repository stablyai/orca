import type { EventEmitter } from 'node:events'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

/** Authentication settlement does not establish physical socket closure. */
export class SshTransportCloseLedger {
  private readonly pending = new Map<EventEmitter, Promise<void>>()

  constructor(private readonly onChange: () => void = () => {}) {}

  isClosed(): boolean {
    return this.pending.size === 0
  }

  track(client: EventEmitter): void {
    if (this.pending.has(client)) {
      return
    }
    let resolveClose!: () => void
    const closed = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    const onClose = (): void => {
      client.off('close', onClose)
      this.pending.delete(client)
      resolveClose()
      this.onChange()
    }
    this.pending.set(client, closed)
    client.on('close', onClose)
  }

  /** Caller must fence new allocations before taking this snapshot. */
  async drain(signal: AbortSignal): Promise<void> {
    await waitForPromiseWithSignal(Promise.all(this.pending.values()), signal)
    if (this.pending.size !== 0) {
      throw new Error('ssh_client_close_allocations_changed')
    }
  }
}
