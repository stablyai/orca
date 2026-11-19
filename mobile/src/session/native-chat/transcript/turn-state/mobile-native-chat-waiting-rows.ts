import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-messages-waiting-behind-live-turn'

/** The rows the list draws: messages held behind the live turn move below it, quiet rows drop. */
export function mobileNativeChatWaitingRows(
  rows: readonly NativeChatMessage[],
  enabled: boolean,
  stopping: boolean,
  turnJournal: NativeChatTurnJournal | null,
  quietIds: ReadonlySet<string> | undefined
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
  if (!ids?.size && !quietIds?.size) {
    return { listMessages: rows, waitingRows: [], indexById: null }
  }
  return {
    listMessages: rows.filter((message) => !ids?.has(message.id) && !quietIds?.has(message.id)),
    waitingRows: rows.flatMap((item, index) => (ids?.has(item.id) ? [{ item, index }] : [])),
    indexById: new Map(rows.map((message, index) => [message.id, index]))
  }
}
