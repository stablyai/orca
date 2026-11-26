import { providerRelayRunLiveness } from '../../../provider-relay/app-provider-relays'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import {
  restoreJournalSqlFailure,
  type JournalWriterSettled
} from '../../agent-session-journal/journal-sql-failure'

/** A chat's history never waits long on a late terminal host; its first send waits instead. */
const KEPT_LISTING_OPEN_WAIT_MS = 1_500

/**
 * Whether the last run's agent may still run under the terminal host, so its open settles nothing.
 * Only where the run started decides: a run in this app ended with it; a relayed run is kept or
 * gone by its own daemon start's word (or proof), and unknown while that start can't say, in which
 * case the host holds the chat until it can.
 */
export async function structuredAgentSessionKeptAtOpen(
  record: Pick<
    AgentSessionConversationView,
    'sessionId' | 'provider' | 'location' | 'lastRunPlacement'
  >,
  waitMs = KEPT_LISTING_OPEN_WAIT_MS
): Promise<boolean> {
  return (await providerRelayRunLiveness(record, { waitMs })) !== 'gone'
}

/**
 * The open recovery a kept open skipped: handed-over sends become unknown, and a stopped queue awaits
 * reopen from the open's own boundary, so a Resume pressed since then still stands.
 */
export async function recoverStructuredAgentSessionKeptOpen(
  journal: Pick<SqlAgentSessionJournal, 'write' | 'markQueueReopen'>,
  fence: number,
  openedSince: number
): Promise<void> {
  const commit = await journal.write({ kind: 'pending-unknown', fence })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pending-unknown returns settled ids or a serialized writer failure.
  const result = commit.value as JournalWriterSettled<unknown>
  if (result !== null && typeof result === 'object' && 'failure' in result) {
    throw restoreJournalSqlFailure(result.failure)
  }
  await journal.markQueueReopen(fence, openedSince)
}
