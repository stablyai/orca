export class TerminalHostTombstones {
  private readonly killed = new Map<string, number>()

  constructor(private readonly capacity: number) {}

  clearForCreate(sessionId: string): void {
    this.killed.delete(sessionId)
  }

  record(sessionId: string): void {
    this.killed.delete(sessionId)
    this.killed.set(sessionId, Date.now())
    if (this.killed.size <= this.capacity) {
      return
    }
    const oldest = this.killed.keys().next().value
    if (oldest) {
      this.killed.delete(oldest)
    }
  }

  has(sessionId: string): boolean {
    return this.killed.has(sessionId)
  }

  clear(): void {
    this.killed.clear()
  }
}
