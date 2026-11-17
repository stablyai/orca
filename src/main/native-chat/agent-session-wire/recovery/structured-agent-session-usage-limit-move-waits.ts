/** Due chats whose agent still works on the account they are leaving: their continue waits. */
export class UsageLimitMoveWaits {
  private readonly waiting = new Set<string>()

  constructor(private readonly stopsWaiting: (id: string) => void) {}

  has(id: string): boolean {
    return this.waiting.has(id)
  }

  /** Whether `id` changed: it now waits, or no longer does and lets go of its read. */
  set(id: string, awaiting: boolean): boolean {
    if (awaiting === this.waiting.has(id)) {
      return false
    }
    if (awaiting) {
      this.waiting.add(id)
    } else {
      this.waiting.delete(id)
      this.stopsWaiting(id)
    }
    return true
  }

  retain(shown: ReadonlySet<string>): void {
    for (const id of [...this.waiting].filter((waiting) => !shown.has(waiting))) {
      this.set(id, false)
    }
  }

  clear(): void {
    this.waiting.clear()
  }
}
