import type {
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult
} from '../../../shared/agent-session-wire'
import type { JournalQueueCardChange } from './journal-queue-events'
import { isUnsettledQueuedMessage, type QueuedMessageRow } from './queued-message-table'

/** User cards exchange their existing slots; automatic mail keeps its position and eligibility. */
export function queuedMessageMovePlan(
  cards: readonly QueuedMessageRow[],
  input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor
): { changes: JournalQueueCardChange[]; result: AgentSessionQueuedMessageMoveResult } {
  const users = cards.filter(
    (card) => isUnsettledQueuedMessage(card) && card.body.from === undefined
  )
  const moving = users.find((card) => card.messageId === input.messageId)
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
  const rest = users.filter((card) => card !== moving)
  const neighbor =
    anchor === null ? rest.length : rest.findIndex((card) => card.messageId === anchor)
  if (neighbor === -1) {
    return answer('stale')
  }
  const index = neighbor + (input.afterMessageId !== undefined ? 1 : 0)
  rest.splice(index, 0, moving)
  const changes = rest.flatMap((card, at) => {
    const position = users[at].position
    return position === card.position
      ? []
      : [{ messageId: card.messageId, change: { op: 'moved' as const, position } }]
  })
  return {
    changes,
    result: { messageId: input.messageId, status: changes.length ? 'moved' : 'unchanged' }
  }
}

/** A conditional withdrawal may refuse only while the journal owns the comparison and write. */
export class QueuedMessageBodyChangedError extends Error {}
