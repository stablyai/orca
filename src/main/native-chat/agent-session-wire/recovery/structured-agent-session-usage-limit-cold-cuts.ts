import type { HostUsageLimitCut } from './structured-agent-session-usage-limit-chain'
import type { StructuredAgentSessionHostDeps as HostDeps } from '../host/structured-agent-session-host-types'

export type UsageLimitCutReads = {
  sessions: ReadonlyMap<string, unknown>
  /** Reads an unopened chat's saved cut; history-sized, so the sweep budgets it. */
  readSavedCut: (id: string) => Promise<HostUsageLimitCut | null>
  readLoadedCut: (id: string) => Promise<HostUsageLimitCut | null>
}

type Deps = UsageLimitCutReads & {
  logger: HostDeps['logger']
  /** The cut with a switch standing in for its unknown reset (UsageLimitAccountHolds). */
  switchReset: (id: string, cut: HostUsageLimitCut) => HostUsageLimitCut
}

/** The cuts of chats that aren't loaded, read from history a few per pass. */
export class UsageLimitColdCuts {
  private readonly cuts = new Map<string, HostUsageLimitCut | null>()
  /** Pass of each chat's last failed history read; failed reads wait behind unread chats. */
  private readonly failures = new Map<string, number>()
  /** Chats whose sweep read threw, so each failure is logged once rather than every pass. */
  private readonly sweepFailures = new Set<string>()
  private passes = 0

  constructor(private readonly deps: Deps) {}

  get size(): number {
    return this.cuts.size + this.failures.size
  }

  has(id: string): boolean {
    return this.cuts.has(id)
  }

  /** The cut as the journal stands now, with a switch standing in for an unknown reset. */
  async read(id: string, cold = false): Promise<HostUsageLimitCut | null> {
    const cut = await this.readJournal(id, cold)
    return cut && this.deps.switchReset(id, cut)
  }

  /** The sweep reads the journal's own cut: it attributes the chat before a switch can stand in. */
  private async readJournal(id: string, cold = false): Promise<HostUsageLimitCut | null> {
    if (this.deps.sessions.has(id)) {
      this.cuts.delete(id)
      return this.deps.readLoadedCut(id)
    }
    if (!this.cuts.has(id) && cold) {
      this.cuts.set(id, await this.deps.readSavedCut(id))
    }
    return this.cuts.get(id) ?? null
  }

  /** One chat that can't be read (a corrupt journal) is skipped this pass instead of failing it. */
  async readForSweep(id: string): Promise<HostUsageLimitCut | null | 'unreadable'> {
    try {
      const cut = await this.readJournal(id)
      this.sweepFailures.delete(id)
      return cut
    } catch (error) {
      if (!this.sweepFailures.has(id)) {
        this.sweepFailures.add(id)
        this.deps.logger.warn('usage-limit continue could not read a chat', {
          scope: 'usage-limit-continue',
          sessionId: id,
          error
        })
      }
      return 'unreadable'
    }
  }

  /** At most three history reads per pass; a read that throws stays retryable without starving others. */
  async readUnread(visible: readonly string[]): Promise<void> {
    const pass = ++this.passes
    const unread = visible.filter((id) => !this.deps.sessions.has(id) && !this.cuts.has(id))
    unread.sort((a, b) => (this.failures.get(a) ?? 0) - (this.failures.get(b) ?? 0))
    for (const id of unread.slice(0, 3)) {
      try {
        await this.readJournal(id, true)
        this.failures.delete(id)
      } catch (error) {
        if (!this.failures.has(id)) {
          this.deps.logger.warn('usage-limit continue could not read a chat', {
            scope: 'usage-limit-continue',
            sessionId: id,
            error
          })
        }
        this.failures.set(id, pass)
      }
    }
  }

  retain(shown: ReadonlySet<string>): void {
    for (const cache of [this.cuts, this.failures]) {
      for (const id of cache.keys()) {
        if (!shown.has(id)) {
          cache.delete(id)
        }
      }
    }
    // Loaded chats are still swept while hidden; logging their failure once must survive that.
    for (const id of this.sweepFailures) {
      if (!shown.has(id) && !this.deps.sessions.has(id)) {
        this.sweepFailures.delete(id)
      }
    }
  }

  forget(id: string): void {
    this.cuts.delete(id)
    this.failures.delete(id)
    this.sweepFailures.delete(id)
  }

  clear(): void {
    this.cuts.clear()
    this.failures.clear()
    this.sweepFailures.clear()
  }
}
