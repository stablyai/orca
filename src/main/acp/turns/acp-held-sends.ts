import type { AcpStructuredSend } from './acp-turn-dispatch-contract'

export class AcpHeldSends {
  private readonly ids = new Set<string>()
  private version = 0
  private captured = { version: 0, ids: new Set<string>() }

  add(id: string): void {
    if (!this.ids.has(id)) {
      this.ids.add(id)
      this.version += 1
    }
  }

  delete(id: string): boolean {
    if (!this.ids.delete(id)) {
      return false
    }
    this.version += 1
    return true
  }

  take(sends: AcpStructuredSend[]): AcpStructuredSend[] {
    const removed = sends.filter(({ clientMessageId }) => this.ids.delete(clientMessageId))
    if (removed.length > 0) {
      this.version += 1
    }
    return removed
  }

  snapshot(): ReadonlySet<string> {
    if (this.captured.version !== this.version) {
      this.captured = { version: this.version, ids: new Set(this.ids) }
    }
    return this.captured.ids
  }
}
