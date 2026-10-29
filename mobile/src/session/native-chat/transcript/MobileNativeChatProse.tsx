import { useContext, useEffect, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { isImageRefBlock, isTextBlock } from '../../../../../src/shared/native-chat-types'
import type {
  NativeChatBlock,
  NativeChatImageRefBlock
} from '../../../../../src/shared/native-chat-types'
import { isAgentSessionHostStatusPresentation } from '../../../../../src/shared/agent-session-host-status-rows'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../src/shared/native-chat/native-chat-visual-directive'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import {
  isRenderableImageUri,
  readHostChatImage,
  type MobileNativeChatImageSource
} from '../visual/mobile-native-chat-image-preview'
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
