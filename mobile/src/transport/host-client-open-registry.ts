export type HostClientOpenTicket = {
  cancelled: boolean
  generation: number
  promise: Promise<void>
}

export class HostClientOpenRegistry {
  private readonly pending = new Map<string, HostClientOpenTicket>()
  private readonly generations = new Map<string, number>()

  getActivePromise(hostId: string): Promise<void> | null {
    const ticket = this.pending.get(hostId)
    return ticket && !ticket.cancelled ? ticket.promise : null
  }

  register(hostId: string, promise: Promise<void>): HostClientOpenTicket {
    const ticket = {
      cancelled: false,
      generation: this.advanceGeneration(hostId),
      promise
    }
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
    this.advanceGeneration(hostId)
  }

  isCurrent(hostId: string, ticket: HostClientOpenTicket): boolean {
    return !ticket.cancelled && this.isGenerationCurrent(hostId, ticket.generation)
  }

  isGenerationCurrent(hostId: string, generation: number): boolean {
    return this.generations.get(hostId) === generation
  }

  deleteIfCurrent(hostId: string, ticket: HostClientOpenTicket): void {
    if (this.pending.get(hostId) === ticket) {
      this.pending.delete(hostId)
    }
  }

  cancelAll(): void {
    for (const [hostId, ticket] of this.pending) {
      ticket.cancelled = true
      this.advanceGeneration(hostId)
    }
    this.pending.clear()
  }

  private advanceGeneration(hostId: string): number {
    const generation = (this.generations.get(hostId) ?? 0) + 1
    this.generations.set(hostId, generation)
    return generation
  }
}
