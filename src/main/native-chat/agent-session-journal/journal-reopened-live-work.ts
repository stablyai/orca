import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { JournalLoad } from './journal-open'
import type { JournalReducerState } from './journal-reducer'
import type { AgentSessionJournal } from './journal-store'
import {
  staleSubagentRosterRevisions,
  type JournalSubagentLivenessRevision
} from './journal-subagent-liveness'

type ReopenedItem = {
  /** The fold revision the verdict was derived from; any other revision supersedes it. */
  revision: number
  correction: JournalSubagentLivenessRevision
  warned: boolean
}

/** Readable reopen facts survive a failed cleanup write; a new revision supersedes them. */
export class JournalReopenedLiveWork {
  private readonly reopened = new Map<string, ReopenedItem>()
  private epoch = ''
  private pending: Promise<void> | null = null

  constructor(
    private readonly deps: {
      sessionId: string
      state: () => JournalReducerState
      journal: () => AgentSessionJournal
    }
  ) {}

  adopt(loaded: JournalLoad): void {
    this.reopened.clear()
    this.epoch = loaded.state.epoch
    for (const [itemId, item] of loaded.state.items) {
      // Same predicate as the write, so the fold never shows a verdict disk can't receive.
      const [correction] = staleSubagentRosterRevisions([item])
      if (!correction) {
        continue
      }
      this.reopened.set(itemId, { revision: item.revision, correction, warned: false })
      loaded.state.items.set(itemId, { ...item, body: correction.body })
    }
  }

  settle(): Promise<void> {
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(() => this.persist())
        .finally(() => {
          this.pending = null
        })
    }
    return this.pending
  }

  hasUnpersisted(): boolean {
    for (const [itemId, entry] of this.reopened) {
      if (this.matchesReopenedItem(itemId, entry)) {
        return true
      }
    }
    return false
  }

  afterCommit(): void {
    for (const [itemId, entry] of this.reopened) {
      if (!this.matchesReopenedItem(itemId, entry)) {
        this.reopened.delete(itemId)
      }
    }
    if (this.reopened.size > 0) {
      void (this.pending ?? Promise.resolve()).then(() => this.settle())
    }
  }

  private matchesReopenedItem(itemId: string, entry: ReopenedItem): boolean {
    const state = this.deps.state()
    return state.epoch === this.epoch && state.items.get(itemId)?.revision === entry.revision
  }

  private async persist(): Promise<void> {
    for (const [itemId, entry] of this.reopened) {
      try {
        await this.deps.journal().appendResolvedItem(
          () => {
            if (!this.matchesReopenedItem(itemId, entry)) {
              this.reopened.delete(itemId)
              return null
            }
            return entry.correction
          },
          { fence: this.deps.state().highestFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        this.reopened.delete(itemId)
      } catch (error) {
        // Retries ride every later commit; only the first failure is worth a log line.
        if (entry.warned) {
          continue
        }
        entry.warned = true
        console.warn('[journal-open] stale live-work cleanup skipped:', {
          sessionId: this.deps.sessionId,
          itemId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
