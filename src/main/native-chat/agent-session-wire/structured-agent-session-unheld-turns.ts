// A turn row reading running under the live child that the child itself is not running is over.
// Earlier children's rows are swept before attach; this covers rows that reach the live fence
// without the child's own lifecycle, such as restored history.

import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { runningTurnLifecycleRevisions } from './structured-agent-session-stale-turn-verdict'

/** `liveTurnId` undefined means the agent cannot say, so nothing is settled. */
export async function settleUnheldStructuredAgentSessionTurns(
  journal: Pick<
    AgentSessionJournal,
    'visitItemsWithLinkage' | 'itemFence' | 'item' | 'appendPlannedLifecycleBatch'
  >,
  sessionId: string,
  fence: number,
  generation: string,
  liveTurnId: string | null | undefined
): Promise<void> {
  if (liveTurnId === undefined) {
    return
  }
  const unheld: AgentJournalRenderItem[] = []
  journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
    const item =
      body.kind === 'turn' &&
      body.state === 'running' &&
      body.turnId !== liveTurnId &&
      isRootAgentJournalItem(attribution) &&
      journal.itemFence(itemId) === fence
        ? journal.item(itemId)
        : null
    if (item) {
      unheld.push(item)
    }
  })
  if (unheld.length === 0) {
    return
  }
  await journal.appendPlannedLifecycleBatch({
    settlementId: `unheld-turns:${sessionId}:${fence}:${generation}`,
    fence,
    recovered: true,
    plan: () => ({
      mutations: runningTurnLifecycleRevisions(unheld, { state: 'interrupted' }),
      dispatches: []
    })
  })
}
