export type HostClientOpenTicket = {
  cancelled: boolean
  promise: Promise<void>
}

export const HOST_CLIENT_OPEN_MAX_PENDING = 64

export class HostClientOpenRegistry {
  private readonly pending = new Map<string, HostClientOpenTicket>()

  constructor(private readonly maxPending = HOST_CLIENT_OPEN_MAX_PENDING) {}

  getActivePromise(hostId: string): Promise<void> | null {
    const ticket = this.pending.get(hostId)
    return ticket && !ticket.cancelled ? ticket.promise : null
  }

  register(hostId: string, promise: Promise<void>): HostClientOpenTicket {
    const prior = this.pending.get(hostId)
    if (prior) {
      prior.cancelled = true
      this.pending.delete(hostId)
    }
    while (this.pending.size >= Math.max(1, this.maxPending)) {
      const oldestHostId = this.pending.keys().next().value as string | undefined
      if (oldestHostId === undefined) {
        break
      }
      const oldest = this.pending.get(oldestHostId)
      if (oldest) {
        oldest.cancelled = true
      }
      this.pending.delete(oldestHostId)
    }
    const ticket = { cancelled: false, promise }
    this.pending.set(hostId, ticket)
    return ticket
  }

  cancel(hostId: string): void {
    const ticket = this.pending.get(hostId)
    if (ticket) {
      ticket.cancelled = true
      // Why: the host lookup may never settle; release the registry's strong
      // reference immediately while the ticket still cancels its continuation.
      this.pending.delete(hostId)
    }
  }

  deleteIfCurrent(hostId: string, ticket: HostClientOpenTicket): void {
    if (this.pending.get(hostId) === ticket) {
      this.pending.delete(hostId)
    }
  }

  cancelAll(): void {
    for (const ticket of this.pending.values()) {
      ticket.cancelled = true
    }
    this.pending.clear()
  }
}
