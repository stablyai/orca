import { useMemo } from 'react'
import {
  rowsBesideStreamedText,
  createStreamedTextRowProjection
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-messages-waiting-behind-live-turn'

/** Waiting membership reads placement and dispatch, never the streaming reply's text. */
export function useMobileNativeChatWaitingRows(
  rows: readonly NativeChatMessage[],
  journal: NativeChatTurnJournal | null,
  enabled: boolean,
  stopping: boolean
) {
  const base = rowsBesideStreamedText(rows)
  const project = useMemo(() => {
    const ids = enabled
      ? nativeChatMessagesWaitingBehindLiveTurn(
          base,
          journal?.items,
          stopping,
          journal?.submissions,
          journal ?? {}
        )
      : null
    if (!ids?.size) {
      return null
    }
    return {
      list: createStreamedTextRowProjection((message: NativeChatMessage) =>
        ids.has(message.id) ? null : message
      ),
      waiting: createStreamedTextRowProjection((item: NativeChatMessage, index) =>
        ids.has(item.id) ? { item, index } : null
      ),
      indexById: new Map(base.map((message, index) => [message.id, index]))
    }
  }, [base, journal, enabled, stopping])
  const listMessages = project?.list(rows) ?? rows
  const waitingRows = project?.waiting(rows) ?? NO_WAITING
  const indexById = project?.indexById ?? null
  return useMemo(
    () => ({ listMessages, waitingRows, indexById }),
    [listMessages, waitingRows, indexById]
  )
}

const NO_WAITING: readonly { item: NativeChatMessage; index: number }[] = []
