// The room request a member's turn serves, keyed by the post that started it, so every member's
// items and requests for one post share a key, and the owner's words when the owner typed it.
import { startsBotGroupRequest, type BotGroupMessage } from '../../shared/bots/bot-group-schema'
import { sliceAtCodeUnitLimit } from '../../shared/text/surrogate-safe-text-slice'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { groupScopeOfRecord, rootOf } from './bot-group-mail-root'
import type { BotGroupStore } from './bot-group-store'
import type { BotActingTurn } from './bot-request-asker'
import { MAX_REQUEST_TEXT } from './bot-request-text'
import type { BotItemOrigin } from '../../shared/bots/bot-items'

/** The owner's own words: a post stamped as typed by the owner, never an automation's run or event
 *  (also served as the owner's), whatever else it carries. */
const ownersOwnPost = (line: BotGroupMessage): boolean =>
  line.author.kind === 'owner' &&
  line.typedByOwner === true &&
  !line.automationRun &&
  !line.memorySource &&
  !line.triggeredBy

/** The room line a member's turn runs on, from the operation that delivered it, and its request. */
export function groupTurnLine(store: BotGroupStore, sessionId: string, operationId: string | null) {
  const message = operationId ? store.operationMessage(operationId) : null
  const turn = message?.turns.find(
    (entry) => entry.operationId === operationId && entry.sessionId === sessionId
  )
  return message && turn ? { turn, root: rootOf(message) } : null
}

/**
 * The room request a member's turn serves, keyed by the line that started it (the owner's post, or
 * a member's line for an item change or a late report), whichever member runs it and however it got
 * there: its own turn on the post, an @mention hand-off, a peer's request. A turn a peer request woke
 * reads it from that request's record, which every host writes; any other from the room line its
 * opening send delivered. Null when neither names a line this room holds.
 */
export function groupTurnRequest(
  store: BotGroupStore,
  db: OrchestrationDb,
  sessionId: string,
  turn: Pick<BotActingTurn, 'requestIds' | 'openerOperationId' | 'openedBy'>
): { rootKey: string; start: Omit<BotItemOrigin, 'rootKey'> } | null {
  const found = store.memberOf(sessionId)
  if (!found) {
    return null
  }
  const rootRequestId =
    // Only a turn a peer request opened; one steered into a turn a post opened keeps the post's line.
    turn.requestIds.length > 0 && turn.openedBy === undefined
      ? turn.requestIds.flatMap((id) => {
          const row = db.getBotRequest(id)
          const scope = row ? groupScopeOfRecord(row.record) : null
          return scope?.id === found.group.id ? [scope.rootRequestId] : []
        })[0]
      : groupTurnLine(store, sessionId, turn.openerOperationId ?? null)?.root.rootRequestId
  const line = rootRequestId ? store.message(rootRequestId) : null
  if (!line || line.groupId !== found.group.id || !startsBotGroupRequest(line)) {
    return null
  }
  const words = ownersOwnPost(line) ? sliceAtCodeUnitLimit(line.text.trim(), MAX_REQUEST_TEXT) : ''
  return {
    rootKey: `group:${line.groupId}:${line.id}`,
    start: { kind: 'group', at: line.createdAt, request: words || null }
  }
}
