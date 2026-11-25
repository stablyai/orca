// The newest turn of a chat an IM conversation is linked to, with the connector deliveries it took,
// read from the chat's journal as it moves. For IMs that reply through the account's reply outbox,
// where a delivery's own send id is never returned to them.
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { imTurnViewOf, type ImTurnView } from './im-stream-turn-view'

export type ImDeliveryTurn = {
  turnItemId: string
  /** One account's deliveries, in the order the turn took them. The first owns the reply, as the
   *  reply outbox's head does; the rest were carried or steered into it. */
  deliveries: string[]
  view: ImTurnView
}

export type ImStreamJournal = {
  observeJournalPublications(sessionId: string, observer: () => void): () => void
  journalReads(sessionId: string): Promise<Pick<JournalSqlReads, 'operationWindow'>>
}

// A streamed token publishes; the IM edit gap is longer than this anyway.
const READ_GAP_MS = 500

/** The newest root turn among these rows, or null when they hold none. */
export function imDeliveryTurnOf(
  items: readonly AgentJournalRenderItem[],
  account: string
): ImDeliveryTurn | null {
  const turn = items.findLast((item) => item.body.kind === 'turn' && isRootAgentJournalItem(item))
  if (turn?.body.kind !== 'turn') {
    return null
  }
  const opener = turn.body.userItemId
  const users = items.filter(
    (item) =>
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      (item.itemId === opener ||
        (item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turn.itemId))
  )
  users.sort((a, b) => Number(b.itemId === opener) - Number(a.itemId === opener))
  const deliveries: string[] = []
  for (const { body } of users) {
    const stamp = body.kind === 'message' ? body.connectorDelivery : undefined
    if (stamp?.account !== account) {
      continue
    }
    for (const id of [stamp.deliveryId, ...(stamp.carried ?? [])]) {
      if (!deliveries.includes(id)) {
        deliveries.push(id)
      }
    }
  }
  return {
    turnItemId: turn.itemId,
    deliveries,
    view: imTurnViewOf(items, turn.itemId, turn.body.state === 'running', false)
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
  const read = async (): Promise<void> => {
    reading = true
    dirty = false
    try {
      const reads = await journal.journalReads(sessionId)
      // Indexed only: every publication reads, so a chat with a long unsettled backlog shows no
      // progress rather than pay for its whole history each time.
      const { snapshot } = await reads.operationWindow({
        latestTurns: 1,
        withoutToolOutput: true,
        indexedOnly: true
      })
      const turn = imDeliveryTurnOf(snapshot.items, account)
      if (turn && !released) {
        onTurn(turn)
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
