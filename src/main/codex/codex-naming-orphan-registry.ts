// Naming children whose exit a session close could not prove.
//
// The disposable title generator is best-effort, so its exit proof must never
// gate the user's session teardown: a wedged naming child would otherwise make
// the chat unacquirable. An unproven one is handed here instead, forfeiting the
// name while full shutdown keeps retrying until every child is proven stopped.

import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'

export type CodexNamingChild = { close: () => Promise<boolean> }

export class CodexNamingOrphanRegistry {
  private readonly orphans = new Map<string, CodexNamingChild>()
  private sequence = 0

  constructor(private readonly onError?: (scope: string, error: unknown) => void) {}

  /** Takes over a naming child, retrying teardown off the session's critical path. */
  adopt(child: CodexNamingChild, pending?: Promise<boolean>): void {
    const id = `codex-naming-${(this.sequence += 1)}`
    this.orphans.set(id, child)
    void this.settle(id, pending ?? this.attempt(child))
  }

  get size(): number {
    return this.orphans.size
  }

  /** Full shutdown: every adopted child is retried until its exit is proven. */
  closeAll(): Promise<void> {
    return closeProcessRegistry({
      attempts: 3,
      hasEntries: () => this.orphans.size > 0,
      entryIds: () => new Set(this.orphans.keys()),
      closeEntry: async (id) => {
        const child = this.orphans.get(id)
        return child ? this.settle(id, this.attempt(child)) : true
      },
      failureMessage: 'codex conversation naming shutdown could not prove every child stopped'
    })
  }

  private attempt(child: CodexNamingChild): Promise<boolean> {
    return child.close().catch((error: unknown) => {
      this.onError?.('close-naming-process', error)
      return false
    })
  }

  private async settle(id: string, pending: Promise<boolean>): Promise<boolean> {
    const stopped = await pending
    if (stopped) {
      this.orphans.delete(id)
    }
    return stopped
  }
}
