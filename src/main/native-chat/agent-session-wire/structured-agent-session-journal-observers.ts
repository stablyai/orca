import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

type JournalObserver = (journal: AgentSessionJournal) => void

/** Observers of a session's journal publications, row-free wakes included, outside any client stream. */
export class StructuredAgentSessionJournalObservers {
  private readonly bySession = new Map<string, Set<JournalObserver>>()

  constructor(private readonly onFailure: (sessionId: string, error: unknown) => void) {}

  add(sessionId: string, observer: JournalObserver): () => void {
    const observers = this.bySession.get(sessionId) ?? new Set<JournalObserver>()
    this.bySession.set(sessionId, observers.add(observer))
    return () => {
      observers.delete(observer)
      if (observers.size === 0 && this.bySession.get(sessionId) === observers) {
        this.bySession.delete(sessionId)
      }
    }
  }

  publish(sessionId: string, journal: AgentSessionJournal): void {
    for (const observer of this.bySession.get(sessionId) ?? []) {
      try {
        observer(journal)
      } catch (error) {
        this.onFailure(sessionId, error)
      }
    }
  }

  clear(): void {
    this.bySession.clear()
  }
}
