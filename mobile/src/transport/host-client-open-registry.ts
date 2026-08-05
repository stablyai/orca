export type HostClientOpenTicket = {
  cancelled: boolean
  profileVersion: number
  promise: Promise<void>
}

export class HostClientOpenRegistry {
  private readonly pending = new Map<string, HostClientOpenTicket>()

  getActivePromise(hostId: string, profileVersion: number): Promise<void> | null {
    const ticket = this.pending.get(hostId)
    return ticket && !ticket.cancelled && ticket.profileVersion === profileVersion
      ? ticket.promise
      : null
  }

  hasActive(hostId: string): boolean {
    const ticket = this.pending.get(hostId)
    return Boolean(ticket && !ticket.cancelled)
  }

  register(hostId: string, profileVersion: number, promise: Promise<void>): HostClientOpenTicket {
    const previous = this.pending.get(hostId)
    if (previous) {
      previous.cancelled = true
    }
    const ticket = { cancelled: false, profileVersion, promise }
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
