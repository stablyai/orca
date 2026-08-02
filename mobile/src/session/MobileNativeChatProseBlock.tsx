import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native'
import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors } from '../theme/mobile-theme'
import { isImageRefBlock, isTextBlock } from './mobile-native-chat-blocks'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'
import { stripImagePromptMarker } from './mobile-native-chat-image-transcript-markers'
import { styles, TEXT_SIZE } from './mobile-native-chat-message-styles'
import { MobileNativeChatLongText } from './MobileNativeChatLongText'
import {
  mobileNativeChatTextKey,
  type MobileNativeChatTextExpansion
} from './use-mobile-native-chat-text-expansion'

const MAX_EXPANDED_MARKDOWN_CHARS = 100_000
const LOADING_FEEDBACK_DELAY_MS = 200

export function MobileNativeChatProseBlock({
  block,
  messageId,
  invert,
  fontScale,
  textExpansion,
  normalizeImagePromptMarker,
  onOpenFile
}: {
  block: NativeChatBlock
  messageId: string
  invert?: boolean
  fontScale: number
  textExpansion?: MobileNativeChatTextExpansion
  normalizeImagePromptMarker?: boolean
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element | null {
  if (isTextBlock(block)) {
    return (
      <TextBlock
        block={block}
        messageId={messageId}
        invert={invert}
        fontScale={fontScale}
        textExpansion={textExpansion}
        normalizeImagePromptMarker={normalizeImagePromptMarker}
        onOpenFile={onOpenFile}
      />
    )
  }
  if (!isImageRefBlock(block)) {
    return null
  }
  const uri = block.url ?? block.path
  if (isRenderableImageUri(uri)) {
    return (
      <Image
        source={{ uri }}
        style={styles.imageThumb}
        resizeMode="contain"
        accessibilityLabel={block.alt ?? 'Attached image'}
      />
    )
  }
  return (
    <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
      🖼 {block.alt ?? block.path ?? block.url ?? 'image'}
    </Text>
  )
}

function TextBlock({
  block,
  messageId,
  invert,
  fontScale,
  textExpansion,
  normalizeImagePromptMarker,
  onOpenFile
}: {
  block: Extract<NativeChatBlock, { type: 'text' }>
  messageId: string
  invert?: boolean
  fontScale: number
  textExpansion?: MobileNativeChatTextExpansion
  normalizeImagePromptMarker?: boolean
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const key = block.retrieval ? mobileNativeChatTextKey(messageId, block.retrieval) : null
  const expanded = key !== null && textExpansion?.expandedKey === key
  const cached =
    key !== null && textExpansion?.cached?.key === key ? textExpansion.cached.text : null
  const rawContent = expanded && cached !== null ? cached : block.text
  const content = normalizeImagePromptMarker ? stripImagePromptMarker(rawContent) : rawContent
  const useLongText =
    (block.retrieval?.originalChars ?? content.length) > MAX_EXPANDED_MARKDOWN_CHARS
  const loading = key !== null && textExpansion?.loadingKey === key
  const expansionBusy = textExpansion?.loadingKey != null
  const failed = key !== null && textExpansion?.errorKey === key
  const showLoading = useDelayedLoading(loading)
  const contentNoun = invert ? 'message' : 'response'
  const loadingLabel = `Loading full ${contentNoun}…`
  const actionLabel = showLoading
    ? loadingLabel
    : failed
      ? `Retry full ${contentNoun}`
      : expanded
        ? 'Show less'
        : `Show full ${contentNoun}`

  return (
    <View>
      {useLongText ? (
        <MobileNativeChatLongText content={content} fontScale={fontScale} invert={invert} />
      ) : invert ? (
        <Text
          style={[
            styles.userText,
            { fontSize: TEXT_SIZE * fontScale, lineHeight: (TEXT_SIZE + 6) * fontScale }
          ]}
        >
          {content}
        </Text>
      ) : (
        <MobileMarkdown content={content} textScale={1.25 * fontScale} onOpenFile={onOpenFile} />
      )}
      {block.retrieval && textExpansion ? (
        <Pressable
          style={styles.longTextAction}
          disabled={expansionBusy}
          onPress={() => textExpansion.toggle(messageId, block.retrieval!)}
          accessibilityRole="button"
          accessibilityLabel={loading ? loadingLabel : actionLabel}
          accessibilityState={{ busy: loading, disabled: expansionBusy, expanded }}
        >
          {showLoading ? (
            <ActivityIndicator size="small" color={invert ? colors.bgBase : colors.textSecondary} />
          ) : null}
          <Text
            style={[
              styles.longTextActionText,
              invert && styles.longTextActionTextInverted,
              failed && styles.longTextActionError
            ]}
          >
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function useDelayedLoading(loading: boolean): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!loading) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), LOADING_FEEDBACK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])
  return visible
}
