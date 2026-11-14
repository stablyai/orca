import { mobileNativeChatMarkdownImageBlock } from './mobile-native-chat-markdown-image-block'
import { useCallback, useContext, useEffect, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../../../../components/inline-text-selection'
import { MobileNativeChatMarkdown } from './MobileNativeChatMarkdown'
import {
  isImageRefBlock,
  isTextBlock,
  type NativeChatBlock,
  type NativeChatImageRefBlock
} from '../../../../../../src/shared/native-chat/native-chat-types'
import { isAgentSessionHostStatusPresentation } from '../../../../../../src/shared/agent-session/view/agent-session-host-status-rows'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../../src/shared/native-chat/native-chat-visual-directive'
import { MobileNativeChatRowOverlaysContext } from '../message-actions/mobile-native-chat-row-overlays'
import { MobileNativeChatMarkdownRowKeyContext } from '../viewport/mobile-native-chat-disclosure-store'
import {
  isRenderableImageUri,
  readHostChatImage,
  type MobileNativeChatImageSource
} from '../../visual/mobile-native-chat-image-preview'
import {
  CHAT_PROSE_SCALE,
  scaledType,
  styles,
  TEXT_SIZE
} from '../messages/mobile-native-chat-message-styles'
import type { MobileNativeChatVisualRender } from '../../visual/mobile-native-chat-visual-context'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { nativeChatHostStatusCopy } from '../notices/native-chat-notice-copy'
import { pressedStyle } from '../../../../theme/mobile-theme'

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
        <ImageAttachment block={image} fontScale={fontScale} onLongPress={onLongPress} />
      ) : null
    },
    [fontScale, onLongPress]
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
    return <ImageAttachment block={block} fontScale={fontScale} onLongPress={onLongPress} />
  }
  return null
}

// Host paths cannot load on the phone; the chat's host reads them, and a refused read stays a placeholder.
function ImageAttachment({
  block,
  fontScale,
  onLongPress
}: {
  block: NativeChatImageRefBlock
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { openImage, imageSource } = useContext(MobileNativeChatRowOverlaysContext)
  const direct = block.url ?? block.path
  const renderable = isRenderableImageUri(direct) ? direct : null
  const hostPath = !renderable && imageSource && block.path ? block.path : null
  const [hostRead, setHostRead] = useState<{
    source: MobileNativeChatImageSource
    path: string
    uri: string | null
  } | null>(null)
  useEffect(() => {
    if (!imageSource || !hostPath) {
      return
    }
    const unmounted = new AbortController()
    void readHostChatImage(imageSource, hostPath, unmounted.signal).then((uri) => {
      if (!unmounted.signal.aborted) {
        setHostRead({ source: imageSource, path: hostPath, uri })
      }
    })
    return () => unmounted.abort()
  }, [imageSource, hostPath])
  const read =
    hostPath && hostRead?.path === hostPath && hostRead.source === imageSource ? hostRead : null
  const uri = renderable ?? read?.uri
  const label = block.alt ?? t('chat.nativeChatProse.attachedImage', 'Attached image')
  if (hostPath && !read) {
    return <View style={styles.imageThumb} accessibilityLabel={label} />
  }
  if (!uri) {
    return (
      <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
        🖼 {block.alt ?? block.path ?? block.url ?? t('chat.nativeChatProse.image', 'image')}
      </Text>
    )
  }
  return (
    <Pressable
      style={({ pressed }) => pressed && pressedStyle}
      onPress={() => openImage({ uri, label })}
      onLongPress={onLongPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityHint={t('chat.nativeChatProse.openImageHint', 'Opens the image full size')}
    >
      <Image source={{ uri }} style={styles.imageThumb} resizeMode="contain" />
    </Pressable>
  )
}
