export const MAX_CODEX_ACTIVE_TURNS = 256
export const MAX_CODEX_ACTIVE_TURN_BYTES = 256 * 1024

export class CodexJournalActiveTurns {
  /** Bounds active turn keys retained across provider threads. */
  static readonly MAX_ENTRIES = MAX_CODEX_ACTIVE_TURNS
  readonly byThread = new Map<string, Set<string>>()
  private activeCount = 0
  private retainedBytes = 0

  get size(): number {
    return this.activeCount
  }

  get bytes(): number {
    return this.retainedBytes
  }

  private entryBytes(threadId: string, turnId: string): number {
    return Buffer.byteLength(threadId, 'utf8') + Buffer.byteLength(turnId, 'utf8')
  }

  canRemember(threadId: string, turnId: string): boolean {
    const active = this.byThread.get(threadId)
    return (
      active?.has(turnId) === true ||
      (this.activeCount < CodexJournalActiveTurns.MAX_ENTRIES &&
        this.retainedBytes + this.entryBytes(threadId, turnId) <= MAX_CODEX_ACTIVE_TURN_BYTES)
    )
  }

  current(threadId: string): string | null {
    return [...(this.byThread.get(threadId) ?? [])].at(-1) ?? null
  }

  remember(threadId: string, turnId: string): boolean {
    const active = this.byThread.get(threadId)
    if (active?.has(turnId)) {
      return true
    }
    if (!this.canRemember(threadId, turnId)) {
      return false
    }
    if (active) {
      active.add(turnId)
    } else {
      this.byThread.set(threadId, new Set([turnId]))
    }
    this.activeCount += 1
    this.retainedBytes += this.entryBytes(threadId, turnId)
    return true
  }

  forget(threadId: string, turnId: string): void {
    const active = this.byThread.get(threadId)
    if (active?.delete(turnId)) {
      this.activeCount -= 1
      this.retainedBytes = Math.max(0, this.retainedBytes - this.entryBytes(threadId, turnId))
    }
    if (!active?.size) {
      this.byThread.delete(threadId)
    }
  }

  clear(): void {
    this.byThread.clear()
    this.activeCount = 0
    this.retainedBytes = 0
  }
}
