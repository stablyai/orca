import type {
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult
} from '../../../shared/agent-session-wire'
import type { JournalQueueCardChange } from './journal-queue-events'
import { isUnsettledQueuedMessage, type QueuedMessageRow } from './queued-message-table'

/** Permute unsettled positions without changing sender, enqueue/pause/hold facts or edit leases. */
export function queuedMessageMovePlan(
  cards: readonly QueuedMessageRow[],
  input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor
): { changes: JournalQueueCardChange[]; result: AgentSessionQueuedMessageMoveResult } {
  const unsettled = cards.filter(isUnsettledQueuedMessage)
  const moving = unsettled.find((card) => card.messageId === input.messageId)
  const answer = (status: AgentSessionQueuedMessageMoveResult['status']) => ({
    changes: [],
    result: { messageId: input.messageId, status }
  })
  if (!moving) {
    return answer('gone')
  }
  const anchor = input.afterMessageId ?? input.beforeMessageId
  if (anchor === moving.messageId) {
    return answer('unchanged')
  }
  const rest = unsettled.filter((card) => card !== moving)
  const neighbor =
    anchor === null ? rest.length : rest.findIndex((card) => card.messageId === anchor)
  if (neighbor === -1) {
    return answer('stale')
  }
  const index = neighbor + (input.afterMessageId !== undefined ? 1 : 0)
  rest.splice(index, 0, moving)
  const changes = rest.flatMap((card, at) => {
    const position = unsettled[at].position
    return position === card.position
      ? []
      : [{ messageId: card.messageId, change: { op: 'moved' as const, position } }]
  })
  return {
    changes,
    result: { messageId: input.messageId, status: changes.length ? 'moved' : 'unchanged' }
  }
}
