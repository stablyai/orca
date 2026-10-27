import { settleBeforeDeadline } from './settle-before-deadline'

/** Shared spawns avoid serial multi-tab startup; exclusive sleep/adoption fences mutations. Once an exclusive waiter queues, later spawns wait so sleep cannot starve. */
/** shared permits parallel spawns; exclusive sleep/adoption cannot interleave with spawns or each other. */
export type WorktreeTerminalMutationKind = 'shared' | 'exclusive'

type Waiter = {
  kind: WorktreeTerminalMutationKind
  grant: () => void
}

type LockEntry = {
  activeSpawns: number
  activeSleep: boolean
  queue: Waiter[]
}

export const WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR = 'terminal_worktree_sleep_timeout'

export class WorktreeTerminalMutationLock {
  private readonly entries = new Map<string, LockEntry>()

  hasActiveSpawns(key: string): boolean {
    return (this.entries.get(key)?.activeSpawns ?? 0) > 0
  }

  /** Expose entry count so tests detect leaked per-workspace locks. */
  get trackedKeyCount(): number {
    return this.entries.size
  }

  async acquire(
    key: string,
    kind: WorktreeTerminalMutationKind,
    deadline?: number
  ): Promise<() => void> {
    const entry = this.entries.get(key) ?? { activeSpawns: 0, activeSleep: false, queue: [] }
    this.entries.set(key, entry)

    if (this.canGrantImmediately(entry, kind)) {
      this.markActive(entry, kind)
      return this.createRelease(key, entry, kind)
    }

    let grant!: () => void
    const granted = new Promise<void>((resolve) => {
      grant = resolve
    })
    const waiter: Waiter = { kind, grant }
    entry.queue.push(waiter)

    try {
      await (deadline === undefined
        ? granted
        : settleBeforeDeadline(
            () => granted,
            undefined,
            deadline,
            new Error(WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR)
          ))
    } catch (error) {
      // Remove timed-out waiters synchronously before draining so they can never acquire later and stop terminals after the caller abandoned them.
      const index = entry.queue.indexOf(waiter)
      if (index !== -1) {
        entry.queue.splice(index, 1)
      }
      this.drain(key, entry)
      throw error
    }

    return this.createRelease(key, entry, kind)
  }

  private canGrantImmediately(entry: LockEntry, kind: WorktreeTerminalMutationKind): boolean {
    if (entry.activeSleep) {
      return false
    }
    if (kind === 'exclusive') {
      return entry.activeSpawns === 0 && entry.queue.length === 0
    }
    // Writer preference: a queued exclusive blocks later shared acquires.
    return !entry.queue.some((waiter) => waiter.kind === 'exclusive')
  }

  private markActive(entry: LockEntry, kind: WorktreeTerminalMutationKind): void {
    if (kind === 'exclusive') {
      entry.activeSleep = true
      return
    }
    entry.activeSpawns += 1
  }

  private createRelease(
    key: string,
    entry: LockEntry,
    kind: WorktreeTerminalMutationKind
  ): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      if (kind === 'exclusive') {
        entry.activeSleep = false
      } else {
        entry.activeSpawns = Math.max(0, entry.activeSpawns - 1)
      }
      this.drain(key, entry)
    }
  }

  private drain(key: string, entry: LockEntry): void {
    // Granting a sleep sets activeSleep, which ends the loop on the next test.
    while (!entry.activeSleep && entry.queue.length > 0) {
      const next = entry.queue[0]!
      if (next.kind === 'exclusive' && entry.activeSpawns > 0) {
        break
      }
      entry.queue.shift()
      this.markActive(entry, next.kind)
      next.grant()
    }
    if (entry.activeSpawns === 0 && !entry.activeSleep && entry.queue.length === 0) {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
      }
    }
  }
}
