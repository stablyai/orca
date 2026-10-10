import { useCallback, type ComponentProps } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { useMobileNativeChatRowProps } from './use-mobile-native-chat-row-props'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

type Row = { item: NativeChatMessage; index: number }

type MessageOptions = Pick<
  ComponentProps<typeof MobileNativeChatMessage>,
  'toolsExpanded' | 'fontScale' | 'onOpenFile' | 'structuredActivityUi' | 'onToggleTurn'
>

/** The list's row renderer and the footer's waiting-row renderer, drawing one message element. */
export function useMobileNativeChatRowRenderers(
  listMessages: readonly NativeChatMessage[],
  resolveTurnRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow,
  { toolsExpanded, fontScale, onOpenFile, structuredActivityUi, onToggleTurn }: MessageOptions
): {
  renderItem: (row: Row) => React.JSX.Element
  renderWaitingRow: (row: Row) => React.JSX.Element
} {
  const listRowProps = useMobileNativeChatRowProps(listMessages, resolveTurnRow)
  const renderMessage = useCallback(
    (item: NativeChatMessage, turnRow: MobileNativeChatTurnRow | undefined) => (
      <MobileNativeChatMessage
        message={item}
        toolsExpanded={toolsExpanded}
        fontScale={fontScale}
        onOpenFile={onOpenFile}
        structuredActivityUi={structuredActivityUi}
        onToggleTurn={onToggleTurn}
        {...turnRow}
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
    ({ item, index }: Row) => renderMessage(item, resolveTurnRow(index, item)),
    [renderMessage, resolveTurnRow]
  )
  return { renderItem, renderWaitingRow }
}
