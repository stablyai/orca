import {
  switchFreeIdentity,
  type HostUsageLimitCut
} from './structured-agent-session-usage-limit-chain'
import type { UsageLimitAccountHolds } from './structured-agent-session-usage-limit-account-hold'
import type { UsageLimitContinueDeps } from './structured-agent-session-usage-limit-continue-deps'

export type UsageLimitCutReads = {
  sessions: ReadonlyMap<string, unknown>
  /** Reads an unopened chat's saved cut; history-sized, so the sweep budgets it. */
  readSavedCut: (id: string) => Promise<HostUsageLimitCut | null>
  readLoadedCut: (id: string) => Promise<HostUsageLimitCut | null>
}

type Deps = UsageLimitCutReads &
  Pick<UsageLimitContinueDeps, 'host' | 'now'> & {
    holds: UsageLimitAccountHolds
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
  /** The cut each loaded chat that isn't open was last attributed for. */
  private readonly attributed = new Map<string, string>()
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
        this.deps.host.logger.warn('usage-limit continue could not read a chat', {
          scope: 'usage-limit-continue',
          sessionId: id,
          error
        })
      }
      return 'unreadable'
    }
  }

  /** Attributes a loaded chat that isn't open, which the sweep otherwise never reaches: once per
   *  cut and per account move (its attribution's sources or launch changing), not every pass. */
  async attributeUnopened(id: string, cut: HostUsageLimitCut, open: ReadonlySet<string>) {
    const { holds, host, now } = this.deps
    const key = switchFreeIdentity(cut)
    if (open.has(id)) {
      this.attributed.delete(id)
    } else if (
      this.attributed.get(id) !== key ||
      !holds.bindingHolds(id, host, holds.attributionBinding(id))
    ) {
      // Only a settled attribution waits for the next move; a failed read is retried next pass.
      if (await holds.attribute(id, host, cut, now())) {
        this.attributed.set(id, key)
      } else {
        this.attributed.delete(id)
      }
    } else {
      holds.askForMoveReading(id, cut.turnEndedAt)
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
          this.deps.host.logger.warn('usage-limit continue could not read a chat', {
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
    for (const id of this.attributed.keys()) {
      if (shown.has(id) || !this.deps.sessions.has(id)) {
        this.attributed.delete(id)
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
    this.attributed.delete(id)
  }

  clear(): void {
    this.cuts.clear()
    this.failures.clear()
    this.sweepFailures.clear()
    this.attributed.clear()
  }
}
