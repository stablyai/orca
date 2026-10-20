import { useCallback, useMemo } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import type { NativeChatTaskListPredecessors } from '../../../src/shared/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { mobileNativeChatUnsentNotices } from './mobile-native-chat-unsent-notices'
import {
  resolveMobileNativeChatRowProps,
  useMobileNativeChatRowProps,
  type MobileNativeChatRowProps
} from './use-mobile-native-chat-row-props'
import type { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

type Row = { item: NativeChatMessage; index: number }

/** Desktop parity: `NativeChatTranscriptRow`'s context. The list's row renderer, and the
 *  footer's waiting-row renderer, drawing one message element. */
export function useMobileNativeChatRowRenderer({
  rowKeyOf,
  runOwners,
  toolsExpanded,
  taskListPredecessors,
  fontScale,
  onOpenFile,
  structuredActivityUi,
  turns,
  turnJournal,
  agent,
  receipts,
  actionablePromptIds
}: {
  /** The row's place on the page, kept while older messages join it. */
  rowKeyOf: (message: NativeChatMessage) => string
  runOwners: ReadonlyMap<string, string>
  toolsExpanded: boolean
  /** The last plan each task-list tool wrote before each row, by row id. */
  taskListPredecessors: ReadonlyMap<string, NativeChatTaskListPredecessors>
  fontScale: number
  onOpenFile?: (relativePath: string) => void
  structuredActivityUi: boolean
  turns: ReturnType<typeof useMobileNativeChatTurnDisclosure>
  turnJournal: NativeChatTurnJournal | null
  agent: string | null | undefined
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  actionablePromptIds: readonly string[] | undefined
}): {
  renderItem: (row: Row) => React.JSX.Element
  renderWaitingRow: (row: Row) => React.JSX.Element
} {
  const unsentNotices = useMemo(
    () => mobileNativeChatUnsentNotices(turnJournal, agent),
    [turnJournal, agent]
  )
  const { listMessages, resolveRow: resolveTurnRow, onToggleTurn } = turns
  const lookups = useMemo(
    () => ({
      resolveTurnRow,
      rowKeyOf,
      runOwners,
      taskListPredecessors,
      unsentNotices,
      receipts,
      actionablePromptIds
    }),
    [
      resolveTurnRow,
      rowKeyOf,
      runOwners,
      taskListPredecessors,
      unsentNotices,
      receipts,
      actionablePromptIds
    ]
  )
  const listRowProps = useMobileNativeChatRowProps(listMessages, lookups)
  // Props every row shares; a change re-renders them all.
  const renderMessage = useCallback(
    (item: NativeChatMessage, rowProps: MobileNativeChatRowProps | undefined) => (
      <MobileNativeChatMessage
        message={item}
        toolsExpanded={toolsExpanded}
        fontScale={fontScale}
        onOpenFile={onOpenFile}
        structuredActivityUi={structuredActivityUi}
        onToggleTurn={onToggleTurn}
        {...rowProps}
      />
    ),
    [toolsExpanded, fontScale, onOpenFile, structuredActivityUi, onToggleTurn]
  )
  const renderItem = useCallback(
    ({ item, index }: Row) => renderMessage(item, listRowProps[index]),
    [renderMessage, listRowProps]
  )
  // Waiting rows draw in the footer, outside the list's cell reuse.
  const renderWaitingRow = useCallback(
    ({ item, index }: Row) =>
      renderMessage(item, resolveMobileNativeChatRowProps(index, item, lookups)),
    [renderMessage, lookups]
  )
  return { renderItem, renderWaitingRow }
}
