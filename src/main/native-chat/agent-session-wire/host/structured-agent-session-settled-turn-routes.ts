import type { JournalWriterCommit } from '../../agent-session-journal/journal-writer-changes'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type SettledTurnsListener = (turnItemIds: readonly string[]) => void

/** Route each commit's terminal turn rows only to sinks bound to that exact journal. */
export class StructuredAgentSessionSettledTurnRoutes {
  private readonly routes = new Map<
    string,
    Set<{ journal: AgentSessionJournal; listener: SettledTurnsListener }>
  >()

  constructor(private readonly logger: StructuredAgentSessionLogger) {}

  observe = (
    sessionId: string,
    journal: AgentSessionJournal,
    listener: SettledTurnsListener
  ): (() => void) => {
    let listeners = this.routes.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      this.routes.set(sessionId, listeners)
    }
    const registration = { journal, listener }
    listeners.add(registration)
    return () => {
      const current = this.routes.get(sessionId)
      current?.delete(registration)
      if (current?.size === 0) {
        this.routes.delete(sessionId)
      }
    }
  }

  deliver(sessionId: string, journal: AgentSessionJournal, commit: JournalWriterCommit): void {
    const listeners = this.routes.get(sessionId)
    if (!listeners?.size) {
      return
    }
    const turnItemIds = (commit.publication?.items ?? []).flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn && turn.state !== 'running' ? [item.itemId] : []
    })
    if (turnItemIds.length === 0) {
      return
    }
    for (const { journal: bound, listener } of listeners) {
      if (bound !== journal) {
        continue
      }
      try {
        listener(turnItemIds)
      } catch (error) {
        this.logger.warn('delivering settled turns failed', {
          scope: 'journal-delivery',
          sessionId,
          error
        })
      }
    }
  }
}
