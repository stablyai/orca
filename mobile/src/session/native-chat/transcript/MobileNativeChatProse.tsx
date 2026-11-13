import { mobileNativeChatMarkdownImageBlock } from './mobile-native-chat-markdown-image-block'
import { useCallback } from 'react'
import { Text } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { MobileNativeChatMarkdown } from './MobileNativeChatMarkdown'
import {
  isImageRefBlock,
  isTextBlock,
  type NativeChatBlock
} from '../../../../../src/shared/native-chat/native-chat-types'
import { isAgentSessionHostStatusPresentation } from '../../../../../src/shared/agent-session/view/agent-session-host-status-rows'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../src/shared/native-chat/native-chat-visual-directive'
import { MobileNativeChatMarkdownRowKeyContext } from './mobile-native-chat-disclosure-store'
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
  rowKey,
  block,
  text,
  userMessage,
  fontScale,
  onLongPress,
  renderVisual,
  growing = false,
  revealing = false
}: {
  /** The transcript row, so a code block's wrap choice outlives the row's mount. */
  rowKey?: string
  block: NativeChatBlock
  text: string
  userMessage?: boolean
  fontScale: number
  /** Assistant prose of a structured chat only. */
  renderVisual?: MobileNativeChatVisualRender
  /** The reply may still be growing: a directive still being typed at its tail is held back. */
  growing?: boolean
  revealing?: boolean
  /** Android only: routes a long press on a link span to the row's actions sheet. */
  onLongPress?: () => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const renderImage = useCallback(
    (href: string, alt: string): React.ReactNode => {
      const image = mobileNativeChatMarkdownImageBlock(href, alt)
      return image ? (
        <MobileNativeChatImageAttachment
          block={image}
          compact={userMessage}
          fontScale={fontScale}
          onLongPress={onLongPress}
        />
      ) : null
    },
    [fontScale, onLongPress, userMessage]
  )
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
        <MobileNativeChatMarkdown
          content={text}
          tone="userMessage"
          rangeSelectable
          textScale={CHAT_PROSE_SCALE * fontScale}
          onLongPress={onLongPress}
          renderImage={renderImage}
        />
      )
    }
    return (
      <MobileNativeChatMarkdownRowKeyContext.Provider value={rowKey}>
        <MobileNativeChatMarkdown
          content={
            renderVisual && (growing || revealing)
              ? withoutPendingNativeChatVisualDirectiveTail(text)
              : text
          }
          growing={revealing}
          streaming={growing || revealing}
          renderVisual={renderVisual}
          rangeSelectable
          textScale={CHAT_PROSE_SCALE * fontScale}
          onLongPress={onLongPress}
          renderImage={renderImage}
        />
      </MobileNativeChatMarkdownRowKeyContext.Provider>
    )
  }
  if (isImageRefBlock(block)) {
    return (
      <MobileNativeChatImageAttachment
        block={block}
        compact={userMessage}
        fontScale={fontScale}
        onLongPress={onLongPress}
      />
    )
  }
  return null
}
