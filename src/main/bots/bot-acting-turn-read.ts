import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import { endedChatTurnRow } from '../external-conversations/external-conversation-turn-opener'
import {
  readBotActingTurnWithin,
  type BotActingTurn,
  type BotActingTurnLookups
} from './bot-request-asker'

/** The acting turn from the newest turns back, widening the read until one decides it or the read
 *  holds the whole chat: a turn woken only by a worker's report reads the one before it. `before`:
 *  only turns that ended before this one (its turn id or row item id) count, so a turn that opened
 *  since is never read; none when the chat holds no such turn. */
export async function readNewestBotActingTurn(
  reads: Pick<JournalSqlReads, 'operationWindow'>,
  lookups: BotActingTurnLookups,
  before?: string,
  /** False reads only the newest turn, by index alone (an unreadable one throws), settling as if
   *  it were the whole chat: enough for what that turn alone can say, such as where its work started. */
  widen = true
): Promise<BotActingTurn> {
  for (let newestTurns = widen ? 8 : 1; ; newestTurns *= 4) {
    const { snapshot, complete } = await reads.operationWindow({
      latestTurns: newestTurns,
      // Who a turn acted for is in its messages and turn rows; its tool calls would only fill memory.
      turnShape: true,
      // Its own sends say all one turn can; an older unanswered one would only pin the read back.
      ...(widen ? {} : { anchorsOnly: true, indexedOnly: true })
    })
    let items = snapshot.items
    if (before !== undefined) {
      // A chat runs one turn at a time: every row of an earlier turn precedes this turn's row.
      const row = endedChatTurnRow(items, before)
      if (!row && !complete) {
        continue
      }
      items = row ? items.filter((item) => item.sequence < row.sequence) : []
    }
    const turn = readBotActingTurnWithin(
      items,
      lookups,
      snapshot.submissions,
      complete || !widen ? null : newestTurns
    )
    if (turn) {
      return turn
    }
  }
}
