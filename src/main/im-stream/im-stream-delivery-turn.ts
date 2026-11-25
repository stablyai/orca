// The newest turn of a chat an IM conversation is linked to, with the connector deliveries it took,
// read from the chat's journal as it moves. For IMs that reply through the account's reply outbox,
// where a delivery's own send id is never returned to them.
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { imTurnViewOf, type ImTurnView } from './im-stream-turn-view'

export type ImDeliveryTurn = {
  turnItemId: string
  /** One account's deliveries, in the order the turn took them. The first owns the reply, as the
   *  reply outbox's head does; the rest were carried or steered into it. */
  deliveries: string[]
  view: ImTurnView
}

type ImStreamReads = Pick<JournalSqlReads, 'operationWindow' | 'canonicalItemId' | 'item'>

export type ImStreamJournal = {
  observeJournalPublications(sessionId: string, observer: () => void): () => void
  journalReads(sessionId: string): Promise<ImStreamReads>
}

// A streamed token publishes; the IM edit gap is longer than this anyway.
const READ_GAP_MS = 500

/** The newest root turn among these rows, or null when they hold none. */
function newestImTurn(items: readonly AgentJournalRenderItem[]): AgentJournalRenderItem | null {
  return items.findLast((item) => item.body.kind === 'turn' && isRootAgentJournalItem(item)) ?? null
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
  const running = turn.body.kind === 'turn' && turn.body.state === 'running'
  return {
    turnItemId: turn.itemId,
    deliveries,
    view: imTurnViewOf(window.items, turn.itemId, running, false)
  }
}

/** Reads the chat's newest turn after each journal publication, one read at a time; a failed read
 *  waits for the next publication. Returns the release. */
export function watchImDeliveryTurns(
  journal: ImStreamJournal,
  sessionId: string,
  account: string,
  onTurn: (turn: ImDeliveryTurn) => void
): () => void {
  let released = false
  let reading = false
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // A turn's opener never changes, so each turn's is read once.
  let opened: { turnItemId: string; opener: AgentJournalRenderItem } | null = null
  const read = async (): Promise<void> => {
    reading = true
    dirty = false
    try {
      const reads = await journal.journalReads(sessionId)
      // The turn's own rows, by index alone: every publication reads, so neither the turn ahead
      // (its send pins the read to the whole chat) nor an old unanswered send may widen it.
      const { snapshot } = await reads.operationWindow({
        latestTurns: 1,
        withoutTurnAhead: true,
        anchorsOnly: true,
        withoutToolOutput: true,
        indexedOnly: true
      })
      const turn = newestImTurn(snapshot.items)
      if (!turn || turn.body.kind !== 'turn') {
        return
      }
      if (opened?.turnItemId !== turn.itemId) {
        const named = turn.body.userItemId
        const opener = named ? await reads.item(await reads.canonicalItemId(named)) : null
        opened = opener ? { turnItemId: turn.itemId, opener } : null
      }
      if (!released) {
        onTurn(imDeliveryTurnOf(snapshot, turn, opened?.opener ?? null, account))
      }
    } catch {
      // A chat closing or a read racing its writer; the next publication reads again.
    } finally {
      reading = false
      if (dirty) {
        schedule()
      }
    }
  }
  const schedule = (): void => {
    if (released || timer) {
      return
    }
    if (reading) {
      dirty = true
      return
    }
    timer = setTimeout(() => {
      timer = null
      void read()
    }, READ_GAP_MS)
    timer.unref?.()
  }
  const unobserve = journal.observeJournalPublications(sessionId, schedule)
  schedule()
  return () => {
    released = true
    unobserve()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
