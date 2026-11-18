import { rowsBesideStreamedText } from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { useCallback, useMemo } from 'react'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import { nativeChatTaskListPredecessors } from '../../../../../../src/shared/native-chat/input/task-lists/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import { MobileNativeChatRow } from './MobileNativeChatRowItemSource'
import { mobileNativeChatUnsentNotices } from '../../status/mobile-native-chat-unsent-notices'
import type { useMobileNativeChatTurnDisclosure } from '../turn-state/use-mobile-native-chat-turn-disclosure'

export function useMobileNativeChatRowRenderer({
  scope,
  rowKeyOf,
  runOwners,
  data,
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
  data: readonly NativeChatMessage[]
  fontScale: number
  structuredActivityUi: boolean
  turns: ReturnType<typeof useMobileNativeChatTurnDisclosure>
  turnJournal: NativeChatTurnJournal | null
  agent: string | null | undefined
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  actionablePromptIds: readonly string[] | undefined
}): ({ item, index }: { item: NativeChatMessage; index: number }) => React.JSX.Element {
  const structuralData = rowsBesideStreamedText(data)
  const taskListPredecessors = useMemo(
    () => nativeChatTaskListPredecessors(structuralData),
    [structuralData]
  )
  const t = useMobileTranslation()
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
      resolveTurnRow
    }),
    [
      rowKeyOf,
      runOwners,
      taskListPredecessors,
      unsentNotices,
      receipts,
      actionablePromptIds,
      resolveTurnRow
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
