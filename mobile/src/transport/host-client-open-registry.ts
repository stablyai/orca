export type HostClientOpenTicket = {
  cancelled: boolean
  promise: Promise<void>
}

export class HostClientOpenRegistry {
  private readonly pending = new Map<string, HostClientOpenTicket>()

  getActivePromise(hostId: string): Promise<void> | null {
    const ticket = this.pending.get(hostId)
    return ticket && !ticket.cancelled ? ticket.promise : null
  }

  register(hostId: string, promise: Promise<void>): HostClientOpenTicket {
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
