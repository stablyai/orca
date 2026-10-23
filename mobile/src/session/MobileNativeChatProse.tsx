import { useContext } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { ImageOff } from 'lucide-react-native'
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
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'
import { colors, textStyles } from '../theme/mobile-theme'
import { scaledText, styles } from './mobile-native-chat-message-styles'
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
    // A host line standing in for a message too large to send, on the person's own row.
    if (isAgentSessionHostStatusPresentation(block.presentation)) {
      return (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.hostNotice, scaledText(textStyles.body, fontScale)]}
        >
          {AGENT_SESSION_HOST_STATUS_COPY[block.presentation]}
        </Text>
      )
    }
    if (invert) {
      // Your own message sits on a faint tint, so it reads in the transcript's own colours.
      return (
        <MobileMarkdown
          content={text}
          rangeSelectable
          textScale={fontScale}
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
        textScale={fontScale}
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

/** A local preview (composer echo) or real URL draws as a thumbnail that opens full size; a bare
 *  host path (not loadable on the device) falls back to a text placeholder. */
function ImageAttachment({
  block,
  fontScale,
  onLongPress
}: {
  block: NativeChatImageRefBlock
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  const { openImage } = useContext(MobileNativeChatRowOverlaysContext)
  const uri = block.url ?? block.path
  const label = block.alt ?? 'Attached image'
  if (!isRenderableImageUri(uri)) {
    return (
      <View style={styles.imageRef} accessibilityLabel={label}>
        <ImageOff size={16 * fontScale} color={colors.textMuted} strokeWidth={2} />
        <Text style={[styles.imageRefText, scaledText(textStyles.callout, fontScale)]}>
          {block.alt ?? block.path ?? block.url ?? 'Image'}
        </Text>
      </View>
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
