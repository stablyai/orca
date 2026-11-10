import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { DeferredStructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { StructuredAgentSessionSnapshotRoutes } from '../structured-agent-session-snapshot-routes'
import { testEventSinkLogging } from './structured-agent-session-logger.test-fixture'

export async function followTestSinkSnapshots(
  sink: DeferredStructuredAgentSessionEventSink,
  journal: SqlAgentSessionJournal
): Promise<void> {
  const routes = new StructuredAgentSessionSnapshotRoutes(testEventSinkLogging().logger)
  await sink.followSnapshots(routes.observe(journal.identity.sessionId, journal))
}
