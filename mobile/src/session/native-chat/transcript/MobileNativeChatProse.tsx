import { Text } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { isImageRefBlock, isTextBlock } from '../../../../../src/shared/native-chat-types'
import type { NativeChatBlock } from '../../../../../src/shared/native-chat-types'
import { isAgentSessionHostStatusPresentation } from '../../../../../src/shared/agent-session-host-status-rows'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../src/shared/native-chat/native-chat-visual-directive'
import { MobileNativeChatImageAttachment } from '../visual/MobileNativeChatImageAttachment'
import {
  CHAT_PROSE_SCALE,
  scaledType,
  styles,
  TEXT_SIZE
} from './mobile-native-chat-message-styles'
import type { MobileNativeChatVisualRender } from '../visual/mobile-native-chat-visual-context'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { nativeChatHostStatusCopy } from './native-chat-notice-copy'

export function Prose({
  block,
  text,
  userMessage,
  fontScale,
  onOpenFile,
  onLongPress,
  renderVisual,
  growing = false,
  revealing = false
}: {
  block: NativeChatBlock
  text: string
  userMessage?: boolean
  fontScale: number
  /** Assistant prose of a structured chat only. */
  renderVisual?: MobileNativeChatVisualRender
  /** The reply may still be growing: a directive still being typed at its tail is held back. */
  growing?: boolean
  revealing?: boolean
  onOpenFile?: (relativePath: string) => void
  /** Android only: routes a long press on a link span to the row's actions sheet. */
  onLongPress?: () => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (isTextBlock(block)) {
    if (isAgentSessionHostStatusPresentation(block.presentation)) {
      return (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.hostNotice, scaledType(TEXT_SIZE, fontScale)]}
        >
          {nativeChatHostStatusCopy(t)[block.presentation]}
        </Text>
      )
    }
    if (userMessage) {
      return (
        <MobileMarkdown
          content={text}
          tone="userMessage"
          rangeSelectable
          textScale={CHAT_PROSE_SCALE * fontScale}
          onOpenFile={onOpenFile}
          onLongPress={onLongPress}
        />
      )
    }
    return (
      <MobileMarkdown
        content={
          renderVisual && (growing || revealing)
            ? withoutPendingNativeChatVisualDirectiveTail(text)
            : text
        }
        growing={revealing}
        renderVisual={renderVisual}
        rangeSelectable
        textScale={CHAT_PROSE_SCALE * fontScale}
        onOpenFile={onOpenFile}
        onLongPress={onLongPress}
      />
    )
  }
  if (isImageRefBlock(block)) {
    return (
      <MobileNativeChatImageAttachment
        block={block}
        fontScale={fontScale}
        onLongPress={onLongPress}
      />
    )
  }
  return null
}
