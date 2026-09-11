import type { RelayRevokeOutbox, RelayRevokeOutboxItem } from './relay-revoke-outbox'

type RevokingBroker = {
  hostId: string
  ownerIdentityKey: string
  revokeDevice(relayDeviceId: string, reqId: string): Promise<void>
}

type RelayRevokeOutboxFlushOptions = {
  outbox: RelayRevokeOutbox
  /** True once the service is fenced or stopped; re-read between items. */
  isHalted: () => boolean
  /** Removing an item can retire the demand holding the broker open. */
  onDrained: () => void
}

/**
 * Drains queued device revocations over a live relay control. Runs unawaited from
 * inside the coordinator's broker open, so it outlives its own caller.
 */
export class RelayRevokeOutboxFlusher {
  private readonly options: RelayRevokeOutboxFlushOptions

  constructor(options: RelayRevokeOutboxFlushOptions) {
    this.options = options
  }

  async flushAll(broker: RevokingBroker): Promise<void> {
    for (const item of this.options.outbox.pendingFor(broker.ownerIdentityKey, broker.hostId)) {
      // Re-checked per item: a fence can land between two revokes. The outbox is
      // durable, so deferring to the next launch beats pushing control frames
      // through a fence that was supposed to end this session.
      if (this.options.isHalted()) {
        return
      }
      await this.flushItem(broker, item)
    }
  }

  async flushItem(broker: RevokingBroker, item: RelayRevokeOutboxItem): Promise<void> {
    try {
      await broker.revokeDevice(item.relayDeviceId, item.reqId)
      this.options.outbox.remove(item.reqId)
      this.options.onDrained()
    } catch {
      // Why: the durable item is the source of truth; reconnecting the same
      // account/control retries this stable reqId without delaying local revoke.
    }
  }
}
