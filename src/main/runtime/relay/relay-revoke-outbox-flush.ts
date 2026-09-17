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
  /** Called once per flush that emptied at least one item, never on a no-op. */
  onDrained: () => void
}

/**
 * Drains queued device revocations over a live relay control. Runs unawaited from
 * inside the coordinator's broker open, so it outlives its own caller and has to
 * re-check the halt latch itself.
 *
 * Shared shape with the post-quit re-arm this landed beside: an operation that
 * reconciles against state it assumes is registered, from a context where it is
 * not — here the broker is not registered yet, there the service is already closed.
 */
export class RelayRevokeOutboxFlusher {
  private readonly options: RelayRevokeOutboxFlushOptions

  constructor(options: RelayRevokeOutboxFlushOptions) {
    this.options = options
  }

  async flushAll(broker: RevokingBroker): Promise<void> {
    let drained = false
    for (const item of this.options.outbox.pendingFor(broker.ownerIdentityKey, broker.hostId)) {
      // Re-checked per item: a fence can land between two revokes. The outbox is
      // durable, so deferring to the next launch beats pushing control frames
      // through a fence that was supposed to end this session.
      if (this.options.isHalted()) {
        break
      }
      drained = (await this.revoke(broker, item)) || drained
    }
    // Why once, after the loop: this runs from inside the coordinator's open, so
    // `broker` is not registered yet. Reconciling per item read a null ownership
    // and opened a fresh director assignment for every remaining revoke, each one
    // abandoning the broker still working through the loop.
    if (drained) {
      this.options.onDrained()
    }
  }

  async flushItem(broker: RevokingBroker, item: RelayRevokeOutboxItem): Promise<void> {
    if (await this.revoke(broker, item)) {
      this.options.onDrained()
    }
  }

  private async revoke(broker: RevokingBroker, item: RelayRevokeOutboxItem): Promise<boolean> {
    try {
      await broker.revokeDevice(item.relayDeviceId, item.reqId)
      this.options.outbox.remove(item.reqId)
      return true
    } catch {
      // Why: the durable item is the source of truth; reconnecting the same
      // account/control retries this stable reqId without delaying local revoke.
      return false
    }
  }
}
