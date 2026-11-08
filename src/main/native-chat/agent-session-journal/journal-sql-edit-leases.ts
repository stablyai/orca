import {
  QueuedMessageEditLeases,
  type EditLeaseKey
} from './queued-messages/queued-message-edit-leases'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

/** The existing ephemeral owner; card reads stay on the SQL reader. */
export class SqlQueuedMessageEditLeases {
  private readonly owner = new QueuedMessageEditLeases()

  constructor(private readonly get: (id: string) => Promise<QueuedMessageRow | null>) {}

  onDeadline = (wake: () => void): void => this.owner.onDeadline(wake)
  version = (): number => this.owner.version()
  snapshot = () => this.owner.snapshot()
  release = (key: EditLeaseKey, messageId: string): void => this.owner.release(key, messageId)
  retire = (messageId: string): void => this.owner.retire(messageId)
  dispose = (): void => this.owner.dispose()

  async acquire(key: EditLeaseKey, input: { messageId: string; fingerprint: string }) {
    return this.owner.acquire(key, input, await this.rows(input.messageId))
  }

  async renew(key: EditLeaseKey, messageId: string) {
    return this.owner.renew(key, messageId, await this.rows(messageId))
  }

  async heldIds(rows?: readonly QueuedMessageRow[]): Promise<ReadonlySet<string>> {
    return this.owner.heldIds(rows ?? (await this.rows()))
  }

  private async rows(messageId?: string): Promise<QueuedMessageRow[]> {
    const ids = new Set(this.owner.snapshot().map((lease) => lease.messageId))
    if (messageId !== undefined) {
      ids.add(messageId)
    }
    const rows = await Promise.all([...ids].map(this.get))
    return rows.filter((row) => row !== null)
  }
}
