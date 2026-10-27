import { useContext, useEffect, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { isImageRefBlock, isTextBlock } from '../../../src/shared/native-chat-types'
import type {
  NativeChatBlock,
  NativeChatImageRefBlock
} from '../../../src/shared/native-chat-types'
import {
  AGENT_SESSION_HOST_STATUS_COPY,
  isAgentSessionHostStatusPresentation
} from '../../../src/shared/agent-session-host-status-rows'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../src/shared/native-chat-visual-directive'
import { isAgentSessionAttachmentStorePath } from '../../../src/shared/agent-session-attachments'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { isRenderableImageUri, readStoredChatImage } from './mobile-native-chat-image-preview'
import type { RpcClient } from '../transport/rpc-client'
import {
  CHAT_PROSE_SCALE,
  scaledType,
  styles,
  TEXT_SIZE
} from './mobile-native-chat-message-styles'
import type { MobileNativeChatVisualRender } from './mobile-native-chat-visual-context'

export function Prose({
  block,
  text,
  invert,
  fontScale,
  onOpenFile,
  onLongPress,
  renderVisual,
  growing = false,
  revealing = false
}: {
  block: NativeChatBlock
  text: string
  invert?: boolean
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
  if (isTextBlock(block)) {
    if (isAgentSessionHostStatusPresentation(block.presentation)) {
      return (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.hostNotice, scaledType(TEXT_SIZE, fontScale)]}
        >
          {AGENT_SESSION_HOST_STATUS_COPY[block.presentation]}
        </Text>
      )
    }
    if (invert) {
      return (
        <MobileMarkdown
          content={text}
          tone="onBright"
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

// Host paths cannot load on the phone; the chat's host reads its attachment store, anything else stays a placeholder.
function ImageAttachment({
  block,
  fontScale,
  onLongPress
}: {
  block: NativeChatImageRefBlock
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  const { openImage, imageClient } = useContext(MobileNativeChatRowOverlaysContext)
  const direct = block.url ?? block.path
  const renderable = isRenderableImageUri(direct) ? direct : null
  const storedPath =
    !renderable && imageClient && block.path && isAgentSessionAttachmentStorePath(block.path)
      ? block.path
      : null
  const [stored, setStored] = useState<{
    client: RpcClient
    path: string
    uri: string | null
  } | null>(null)
  useEffect(() => {
    if (!imageClient || !storedPath) {
      return
    }
    const unmounted = new AbortController()
    void readStoredChatImage(imageClient, storedPath, unmounted.signal).then((uri) => {
      if (!unmounted.signal.aborted) {
        setStored({ client: imageClient, path: storedPath, uri })
      }
    })
    return () => unmounted.abort()
  }, [imageClient, storedPath])
  const read =
    storedPath && stored?.path === storedPath && stored.client === imageClient ? stored : null
  const uri = renderable ?? read?.uri
  const label = block.alt ?? 'Attached image'
  if (storedPath && !read) {
    return <View style={styles.imageThumb} accessibilityLabel={label} />
  }
  if (!uri) {
    return (
      <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
        🖼 {block.alt ?? block.path ?? block.url ?? 'image'}
      </Text>
    )
  }
  return (
    <Pressable
      onPress={() => openImage({ uri, label })}
      onLongPress={onLongPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityHint="Opens the image full size"
    >
      <Image source={{ uri }} style={styles.imageThumb} resizeMode="contain" />
    </Pressable>
  )
}
