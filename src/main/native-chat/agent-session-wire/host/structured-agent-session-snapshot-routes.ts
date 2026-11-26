import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type {
  StructuredAgentSessionSnapshotRecipient,
  StructuredAgentSessionSnapshotSource
} from '../journal-ingress/structured-agent-session-sink-snapshots'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type Route = {
  journal: AgentSessionJournal
  recipient: StructuredAgentSessionSnapshotRecipient
  reads: number
}

/** Give each Claude acquisition its saved facts, then each epoch replacement's, before later events. */
export class StructuredAgentSessionSnapshotRoutes {
  private readonly routes = new Map<string, Set<Route>>()

  constructor(private readonly logger: StructuredAgentSessionLogger) {}

  observe =
    (sessionId: string, journal: AgentSessionJournal): StructuredAgentSessionSnapshotSource =>
    (recipient) => {
      let routes = this.routes.get(sessionId)
      if (!routes) {
        routes = new Set()
        this.routes.set(sessionId, routes)
      }
      const route: Route = { journal, recipient, reads: 0 }
      // Registered before reading, so a replacement racing the first read is never missed.
      routes.add(route)
      return {
        release: () => {
          const current = this.routes.get(sessionId)
          current?.delete(route)
          if (current?.size === 0) {
            this.routes.delete(sessionId)
          }
        },
        adopted: this.refresh(sessionId, route)
      }
    }

  /** Hold reading before the writer runs the replacement; resume only on its actual facts. */
  replacing(sessionId: string, journal: AgentSessionJournal, replaced: Promise<unknown>): void {
    for (const route of this.routes.get(sessionId) ?? []) {
      if (route.journal !== journal) {
        continue
      }
      const release = route.recipient.hold()
      void replaced
        .catch(() => undefined)
        .then(() => this.refresh(sessionId, route))
        .then(release, (error: unknown) => {
          // Unknown facts keep translation held; the journal's failure path ends the attempt.
          this.logger.warn('reading saved facts after an epoch replacement failed', {
            scope: 'journal-delivery',
            sessionId,
            error
          })
        })
    }
  }

  private async refresh(sessionId: string, route: Route): Promise<void> {
    const read = ++route.reads
    const snapshot = await route.journal.reads.claudeSnapshot()
    // A newer read supersedes this one; a released attempt receives nothing.
    if (read === route.reads && this.routes.get(sessionId)?.has(route)) {
      route.recipient.adopt(snapshot)
    }
  }
}
