import type { EditLeaseKey } from './queued-messages/queued-message-edit-leases'
import type {
  JournalDomainEditLeaseOperation,
  JournalDomainEditLeaseOutcome
} from './journal-domain-edit-leases'

/** The deadline wakes the chat lane; only committed SQL rows decide which editors hold a card. */
export class SqlQueuedMessageEditLeases {
  private deadline: number | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private wake: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly write: (
      operation: JournalDomainEditLeaseOperation
    ) => Promise<JournalDomainEditLeaseOutcome>,
    private readonly now: () => number
  ) {}

  onDeadline(wake: () => void): void {
    this.wake = wake
    this.schedule()
  }

  adoptDeadline(deadline: number | null): void {
    this.deadline = deadline
    this.schedule()
  }

  async acquire(key: EditLeaseKey, input: { messageId: string; fingerprint: string }) {
    return (await this.write({ kind: 'acquire', ...key, ...input })).result!
  }

  async renew(key: EditLeaseKey, messageId: string) {
    return (await this.write({ kind: 'renew', ...key, messageId })).result!
  }

  async release(key: EditLeaseKey, messageId: string): Promise<void> {
    await this.write({ kind: 'release', ...key, messageId })
  }

  async expire(): Promise<void> {
    await this.write({ kind: 'expire' })
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || !this.wake || this.deadline === null) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.wake?.()
      },
      Math.max(1, this.deadline - this.now())
    )
    this.timer.unref()
  }
}
