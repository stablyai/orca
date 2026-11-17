// A turn row reading running under the live child that the child itself is not running is over.
// Earlier children's rows are swept before attach; this covers rows that reach the live fence
// without the child's own lifecycle, such as restored history.

import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'

/** `liveTurnId` undefined means the agent cannot say, so nothing is settled. */
export async function settleUnheldStructuredAgentSessionTurns(
  journal: Pick<AgentSessionJournal, 'settleUnheldTurns'>,
  sessionId: string,
  fence: number,
  generation: string,
  liveTurnId: string | null | undefined
): Promise<void> {
  if (liveTurnId === undefined) {
    return
  }
  await journal.settleUnheldTurns({ sessionId, fence, generation, liveTurnId })
}
