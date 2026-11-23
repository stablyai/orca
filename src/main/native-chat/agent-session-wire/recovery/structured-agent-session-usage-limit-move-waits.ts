import type { UsageLimitContinueDeps } from './structured-agent-session-usage-limit-continue-deps'

type MoveWaitDeps = Pick<
  UsageLimitContinueDeps,
  'awaitsAccountMove' | 'publish' | 'stopsAwaitingAccountMove'
>

/** Due chats whose agent still works on the account they are leaving: their continue waits. */
export class UsageLimitMoveWaits {
  private readonly waiting = new Set<string>()

  constructor(private readonly deps: () => MoveWaitDeps) {}

  has(id: string): boolean {
    return this.waiting.has(id)
  }

  /** Whether a continue now `due` waits on the chat's move; the chat republishes when that changes. */
  async decide(
    id: string,
    due: boolean,
    launchHome?: () => Parameters<NonNullable<MoveWaitDeps['awaitsAccountMove']>>[1]
  ): Promise<boolean> {
    // Only due chats ask; a continue sent now would wait behind the old agent's work anyway.
    const awaiting = due && (await this.deps().awaitsAccountMove?.(id, launchHome?.())) === true
    if (this.set(id, awaiting)) {
      this.deps().publish(id)
    }
    return awaiting
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
      this.deps().stopsAwaitingAccountMove?.(id)
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
