import type { HostUsageLimitCut } from './structured-agent-session-usage-limit-chain'
import type { StructuredAgentSessionHostDeps as HostDeps } from '../host/structured-agent-session-host-types'

type Deps = {
  logger: HostDeps['logger']
  sessions: ReadonlyMap<string, unknown>
  /** Reads an unopened chat's saved cut; history-sized, so the sweep budgets it. */
  readSavedCut: (id: string) => HostUsageLimitCut | null
  readLoadedCut: (id: string) => HostUsageLimitCut | null
  publish: (id: string) => void
}

/** The cuts of chats that aren't loaded, read from history a few per pass. */
export class UsageLimitColdCuts {
  private readonly cuts = new Map<string, HostUsageLimitCut | null>()
  /** Pass of each chat's last failed history read; failed reads wait behind unread chats. */
  private readonly failures = new Map<string, number>()
  /** The continue time each cold chat last published; loaded chats publish every pass. */
  private readonly continueAt = new Map<string, number>()
  private passes = 0

  constructor(private readonly deps: Deps) {}

  get size(): number {
    return this.cuts.size + this.failures.size + this.continueAt.size
  }

  has(id: string): boolean {
    return this.cuts.has(id)
  }

  read(id: string, cold = false): HostUsageLimitCut | null {
    if (this.deps.sessions.has(id)) {
      this.cuts.delete(id)
      return this.deps.readLoadedCut(id)
    }
    if (!this.cuts.has(id) && cold) {
      this.cuts.set(id, this.deps.readSavedCut(id))
    }
    return this.cuts.get(id) ?? null
  }

  /** At most three history reads per pass; a read that throws stays retryable without starving others. */
  readUnread(visible: readonly string[]): void {
    const pass = ++this.passes
    const unread = visible.filter((id) => !this.deps.sessions.has(id) && !this.cuts.has(id))
    unread.sort((a, b) => (this.failures.get(a) ?? 0) - (this.failures.get(b) ?? 0))
    for (const id of unread.slice(0, 3)) {
      try {
        this.read(id, true)
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

  /** A held cold chat's continue time reaches clients only when it moves. */
  publishContinueAt(
    visible: readonly string[],
    continueAt: (id: string, cut: HostUsageLimitCut & { resetsAt: number }) => number
  ): void {
    for (const id of visible) {
      const cut = this.deps.sessions.has(id) ? null : this.cuts.get(id)
      if (cut?.resetsAt === undefined) {
        this.continueAt.delete(id)
        continue
      }
      const at = continueAt(id, { ...cut, resetsAt: cut.resetsAt })
      const previous = this.continueAt.get(id) ?? cut.resetsAt
      this.continueAt.set(id, at)
      if (at !== previous) {
        this.deps.publish(id)
      }
    }
  }

  retain(shown: ReadonlySet<string>): void {
    for (const cache of [this.cuts, this.failures, this.continueAt]) {
      for (const id of cache.keys()) {
        if (!shown.has(id)) {
          cache.delete(id)
        }
      }
    }
  }

  forget(id: string): void {
    this.cuts.delete(id)
    this.failures.delete(id)
    this.continueAt.delete(id)
  }

  clear(): void {
    this.cuts.clear()
    this.failures.clear()
    this.continueAt.clear()
  }
}
