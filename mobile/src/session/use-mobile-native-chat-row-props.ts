import { useMemo, useState } from 'react'
import { createNativeChatRowReuse } from '../../../src/shared/native-chat-row-reuse'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

// Why: a streamed batch rebuilds the lookups behind these props, and each settled turn's
// status object with them; reused, `renderItem` and settled rows keep their identity.
const createTurnRowReuse = () => createNativeChatRowReuse<MobileNativeChatTurnRow>(1)

/** Each listed row's turn props, by list index. */
export function useMobileNativeChatRowProps(
  listMessages: readonly NativeChatMessage[],
  resolveTurnRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
): readonly MobileNativeChatTurnRow[] {
  const [reuseTurnRows] = useState(createTurnRowReuse)
  // Why: the view re-renders on every composer keystroke; only row or turn changes need this pass.
  return useMemo(
    () =>
      reuseTurnRows(
        listMessages.map((message, index) => resolveTurnRow(index, message)),
        (index) => listMessages[index]!.id
      ),
    [reuseTurnRows, listMessages, resolveTurnRow]
  )
}
