import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { writeAgentSessionContextSnapshot } from '../agent-session-context-snapshots'
import { captureRecoveryContext } from './context-transfer-capture'
import type { ContextTransferHandoff } from './context-transfer-record'
import type { JournalHostDatabase } from './journal-host-database'

export async function exportContextTransfer(
  database: JournalHostDatabase,
  sessionId: string,
  snapshot: AgentJournalSnapshot,
  canonical: (id: string) => string,
  handoff: ContextTransferHandoff
): Promise<string | undefined> {
  const cursor = handoff.sourceCursor
  if (!cursor || cursor.epoch !== snapshot.cursor.epoch) {
    return undefined
  }
  const source = captureRecoveryContext(
    {
      ...snapshot,
      items: snapshot.items.filter((item) => item.sequence <= cursor.sequence)
    },
    canonical
  )
  const frozen = handoff.capture.coverage
  if (
    source.capture.coverage.inventoryDigest !== frozen.inventoryDigest ||
    source.capture.coverage.eligibleCount !== frozen.eligibleCount ||
    source.capture.coverage.firstItemId !== frozen.firstItemId ||
    source.capture.coverage.lastItemId !== frozen.lastItemId
  ) {
    return undefined
  }
  // Keyed by the frozen source so the terminal hand-off's chat snapshot cannot replace it.
  return writeAgentSessionContextSnapshot(
    database.stateDirectory,
    `${sessionId}/${handoff.id}`,
    source.text
  )
}
