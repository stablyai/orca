import { RELAY_HOST_ATTACH_DEADLINE_MS } from '../control-channel/relay-control-protocol'
import type {
  RelayConnectionOpenMessage,
  RelayPendingConnection
} from '../control-channel/relay-control-protocol'

const OBSERVED_OPEN_LIMIT = 16

// Retain conn-open metadata for the attach window so older ack frames need not restate kind/device.
export class RelayObservedOpens {
  private readonly opens = new Map<
    string,
    { message: RelayConnectionOpenMessage; seenAt: number }
  >()

  clear(): void {
    this.opens.clear()
  }

  // Rotation/rebind must replay pending attaches because conn-open was emitted only once.
  pendingConnectionOpen(pending: RelayPendingConnection): RelayConnectionOpenMessage | null {
    // Pairing kind/E2EE device must come from relay ack or previously observed conn-open, never guesses.
    const observed = this.opens.get(pending.connId)?.message
    const kind = pending.kind ?? observed?.kind
    const relayDeviceId = pending.relayDeviceId ?? observed?.relayDeviceId
    if (!kind || !relayDeviceId) {
      return null
    }
    return {
      type: 'conn-open',
      connId: pending.connId,
      connTicket: pending.connTicket,
      kind,
      relayDeviceId,
      // Attach began before this control; remaining budget cannot exceed the contract deadline.
      attachDeadlineMs: RELAY_HOST_ATTACH_DEADLINE_MS
    }
  }

  remember(message: RelayConnectionOpenMessage): void {
    const now = Date.now()
    for (const [connId, entry] of this.opens) {
      if (now - entry.seenAt > RELAY_HOST_ATTACH_DEADLINE_MS) {
        this.opens.delete(connId)
      }
    }
    // Session cap is 8; bound retained opens even when the clock stalls.
    while (this.opens.size >= OBSERVED_OPEN_LIMIT) {
      const oldest = this.opens.keys().next()
      if (oldest.done) {
        break
      }
      this.opens.delete(oldest.value)
    }
    this.opens.set(message.connId, { message, seenAt: now })
  }
}
