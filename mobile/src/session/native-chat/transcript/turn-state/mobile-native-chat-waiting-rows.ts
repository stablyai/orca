import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-messages-waiting-behind-live-turn'

/** The rows the list draws: messages held behind the live turn move below it, quiet rows drop. */
export function mobileNativeChatWaitingRows(
  rows: readonly NativeChatMessage[],
  enabled: boolean,
  stopping: boolean,
  turnJournal: NativeChatTurnJournal | null,
  quiet: { ids: ReadonlySet<string>; shown: readonly NativeChatMessage[] } | null
) {
  const ids = enabled
    ? nativeChatMessagesWaitingBehindLiveTurn(
        rows,
        turnJournal?.items,
        stopping,
        turnJournal?.submissions,
        turnJournal ?? {}
      )
    : null
  if (!ids?.size && !quiet?.ids.size) {
    return { listMessages: rows, waitingRows: [], indexById: null }
  }
  return {
    // Rows merged into a later one are among the quiet ids, and draw inside it.
    listMessages: (quiet?.shown ?? rows).filter((m) => !ids?.has(m.id) && !quiet?.ids.has(m.id)),
    waitingRows: rows.flatMap((item, index) => (ids?.has(item.id) ? [{ item, index }] : [])),
    indexById: new Map(rows.map((message, index) => [message.id, index]))
  }
}
