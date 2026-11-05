import type { AgentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  journalDerivedRefreshPending,
  refreshJournalDerivedRead
} from '../agent-session-journal/journal-derived-read'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'

/** Replacement refresh owns cache misses; ordinary point publications remain immediate. */
export class StructuredAgentSessionStatusJournal {
  private readonly projections = new StructuredAgentSessionJournalProjections((id) =>
    this.deps().replacedRuntime?.(id)
  )

  constructor(private readonly deps: () => StructuredAgentSessionStatusFeedDeps) {}

  advance = this.projections.advance.bind(this.projections)

  read(id: string, journal?: AgentSessionJournal, record?: AgentSessionConversationView | null) {
    const deps = this.deps()
    const session = deps.sessions.get(id)
    const source = journal ?? session?.journal
    return !source
      ? null
      : journalDerivedRefreshPending(source)
        ? this.projections.installed(source)
        : this.projections.read(
            source,
            record === undefined ? deps.getConversation(id) : record,
            session
          )
  }

  readStopping(id: string): boolean {
    const journal = this.deps().sessions.get(id)?.journal
    if (
      journal &&
      journalDerivedRefreshPending(journal) &&
      journal.stopMarks.latest()?.settle?.settling
    ) {
      return true
    }
    const projection = this.read(id)
    return projection?.stopping === true && projection.state.summary.status === 'working'
  }

  async refresh(
    id: string,
    journal: AgentSessionJournal,
    observe: () => Promise<void>
  ): Promise<void> {
    return refreshJournalDerivedRead(journal, async () => {
      try {
        await observe()
      } finally {
        await finishJournalStepsAsync(journal.preparePublicReadSteps())
        await this.projections.prepare(this.deps(), id, journal)
      }
    })
  }

  /** Only the invalid replacement view needs the ordered finite read path. */
  afterRefresh(id: string, journal: AgentSessionJournal, publish: () => void): boolean {
    if (!journalDerivedRefreshPending(journal)) {
      return false
    }
    const deps = this.deps()
    const session = deps.sessions.get(id)
    void journal
      .readInOrder(async () => {
        if (deps.sessions.get(id) !== session || session?.journal !== journal) {
          return
        }
        await this.projections.prepare(deps, id, journal)
        if (deps.sessions.get(id) === session && session.journal === journal) {
          publish()
        }
      })
      .catch((error) =>
        deps.logger.warn('publishing refreshed status failed', {
          scope: 'status-refresh',
          sessionId: id,
          error
        })
      )
    return true
  }
}
