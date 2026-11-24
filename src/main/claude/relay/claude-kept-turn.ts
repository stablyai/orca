import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { StructuredAgentSessionHistoryJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import type { ClaudeCurrentTurn } from '../structured/turns/claude-turn-lifecycle-item'

/**
 * The root turn the last app left running for a kept agent. Its output since then replays into this
 * record, so the turn ends once, where it began, rather than staying open beside a second one.
 */
export async function keptClaudeTurn(
  journal: StructuredAgentSessionHistoryJournal | null | undefined,
  providerSessionId: string
): Promise<ClaudeCurrentTurn | null> {
  const items = (await journal?.reads.generation())?.items ?? []
  const running = items.findLast(
    (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)?.state === 'running'
  )
  const turn = running ? readAgentJournalTurn(running.body) : null
  if (!running || !turn?.turnId || turn.startedAt === undefined) {
    return null
  }
  return {
    sessionId: providerSessionId,
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    ...(turn.requestedAt !== undefined ? { requestedAt: turn.requestedAt } : {}),
    userItemId: turn.userItemId ?? running.itemId
  }
}
