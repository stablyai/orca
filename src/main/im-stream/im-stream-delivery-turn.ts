// The newest turn of a chat an IM conversation is linked to, with the connector deliveries it took,
// followed in the chat's journal: every turn as it comes, not only the first. For IMs that reply
// through the account's reply outbox, where a delivery's own send id is never returned to them.
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { followImJournal, type ImJournal, type ImJournalFollowOptions } from './im-stream-follow'
import { imTurnViewOf, type ImTurnView } from './im-stream-turn-view'

export type ImDeliveryTurn = {
  turnItemId: string
  /** One account's deliveries, in the order the turn took them. The first owns the reply, as the
   *  reply outbox's head does; the rest were carried or steered into it. */
  deliveries: string[]
  view: ImTurnView
}

/** The turn's deliveries as the reply outbox credits them: its opener's (and those it carried),
 *  then each send the provider took into it as a steer. */
function imDeliveryTurnOf(
  window: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  turn: AgentJournalRenderItem,
  opener: AgentJournalRenderItem | null,
  account: string
): ImDeliveryTurn {
  const deliveries: string[] = []
  for (const stamp of connectorReplyTurnStamps(window, opener, turn.itemId)) {
    if (stamp.account !== account) {
      continue
    }
    for (const id of [stamp.deliveryId, ...(stamp.carried ?? [])]) {
      if (!deliveries.includes(id)) {
        deliveries.push(id)
      }
    }
  }
  return { turnItemId: turn.itemId, deliveries, view: imTurnViewOf(window.items, turn.itemId) }
}

/** Reads the chat's newest turn after each journal publication; returns the release. */
export function watchImDeliveryTurns(
  journal: ImJournal,
  sessionId: string,
  account: string,
  onTurn: (turn: ImDeliveryTurn) => void,
  options: ImJournalFollowOptions = {}
): () => void {
  // A turn's opener never changes, so each turn's is read once.
  let opened: { turnItemId: string; opener: AgentJournalRenderItem } | null = null
  return followImJournal(
    journal,
    sessionId,
    async (reads, active) => {
      // The turn's own rows, by index alone: every publication reads, so neither the turn ahead
      // (its send pins the read to the whole chat) nor an old unanswered send may widen it.
      const { snapshot } = await reads.operationWindow({
        latestTurns: 1,
        withoutTurnAhead: true,
        anchorsOnly: true,
        withoutToolOutput: true,
        indexedOnly: true
      })
      const turn = snapshot.items.findLast(
        (item) => item.body.kind === 'turn' && isRootAgentJournalItem(item)
      )
      if (turn?.body.kind !== 'turn') {
        return
      }
      if (opened?.turnItemId !== turn.itemId) {
        const named = turn.body.userItemId
        const opener = named ? await reads.item(await reads.canonicalItemId(named)) : null
        opened = opener ? { turnItemId: turn.itemId, opener } : null
      }
      if (active()) {
        onTurn(imDeliveryTurnOf(snapshot, turn, opened?.opener ?? null, account))
      }
    },
    options
  )
}
