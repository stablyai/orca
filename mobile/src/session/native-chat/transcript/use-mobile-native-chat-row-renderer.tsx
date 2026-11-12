import { useCallback, useContext, useMemo } from 'react'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../../src/shared/native-chat/transcript/native-chat-turn-membership'
import type { NativeChatTaskListPredecessors } from '../../../../../src/shared/native-chat/input/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat/native-chat-resolution-receipt'
import { MobileNativeChatRow } from './MobileNativeChatRowItemSource'
import { mobileNativeChatUnsentNotices } from '../mobile-native-chat-unsent-notices'
import type { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import { MobileNativeChatNoticeContext } from './mobile-native-chat-notice-context'

export function useMobileNativeChatRowRenderer({
  scope,
  rowKeyOf,
  runOwners,
  taskListPredecessors,
  fontScale,
  structuredActivityUi,
  turns,
  turnJournal,
  agent,
  receipts,
  actionablePromptIds
}: {
  scope: string
  rowKeyOf: (message: NativeChatMessage) => string
  runOwners: ReadonlyMap<string, string>
  /** The last plan each task-list tool wrote before each row, by row id. */
  taskListPredecessors: ReadonlyMap<string, NativeChatTaskListPredecessors>
  fontScale: number
  structuredActivityUi: boolean
  turns: ReturnType<typeof useMobileNativeChatTurnDisclosure>
  turnJournal: NativeChatTurnJournal | null
  agent: string | null | undefined
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  actionablePromptIds: readonly string[] | undefined
}): ({ item, index }: { item: NativeChatMessage; index: number }) => React.JSX.Element {
  const t = useMobileTranslation()
  const signedOutRetry = useContext(MobileNativeChatNoticeContext).signedOutRetry ?? null
  const unsentNotices = useMemo(
    () => mobileNativeChatUnsentNotices(turnJournal, agent),
    [turnJournal, agent, t]
  )
  const { resolveRow: resolveTurnRow, onToggleTurn } = turns
  const lookups = useMemo(
    () => ({
      rowKeyOf,
      runOwners,
      taskListPredecessors,
      unsentNotices,
      receipts,
      actionablePromptIds,
      resolveTurnRow,
      signedOutRetry
    }),
    [
      rowKeyOf,
      runOwners,
      taskListPredecessors,
      unsentNotices,
      receipts,
      actionablePromptIds,
      resolveTurnRow,
      signedOutRetry
    ]
  )
  return useCallback(
    ({ item, index }) => (
      <MobileNativeChatRow
        key={`${scope}\0${rowKeyOf(item)}`}
        message={item}
        index={index}
        lookups={lookups}
        {...{ scope, fontScale, structuredActivityUi, onToggleTurn }}
      />
    ),
    [scope, rowKeyOf, lookups, fontScale, structuredActivityUi, onToggleTurn]
  )
}
