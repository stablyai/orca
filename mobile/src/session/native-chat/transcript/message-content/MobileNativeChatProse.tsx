import { useNativeChatProseText } from '../../preferences/native-chat-text-settings'
import { mobileNativeChatMarkdownImageBlock } from './mobile-native-chat-markdown-image-block'
import { useCallback, useContext, useEffect, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { INLINE_TEXT_SELECTION } from '../../../../platform/text-selection/inline-text-selection'
import { MobileNativeChatMarkdown } from './MobileNativeChatMarkdown'
import {
  isImageRefBlock,
  isTextBlock,
  type NativeChatBlock,
  type NativeChatImageRefBlock,
  type NativeChatMessage
} from '../../../../../../src/shared/native-chat/native-chat-types'
import { isAgentSessionHostStatusPresentation } from '../../../../../../src/shared/agent-session/view/agent-session-host-status-rows'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../../src/shared/native-chat/visuals/native-chat-visual-directive'
import { MobileNativeChatRowOverlaysContext } from '../message-actions/mobile-native-chat-row-overlays'
import { MobileNativeChatMarkdownRowKeyContext } from '../viewport/mobile-native-chat-disclosure-store'
import {
  isRenderableImageUri,
  readHostChatImage,
  type MobileNativeChatImageSource
} from '../../visual/mobile-native-chat-image-preview'
import { scaledType, styles, TEXT_SIZE } from '../messages/mobile-native-chat-message-styles'
import type { MobileNativeChatVisualRender } from '../../visual/mobile-native-chat-visual-context'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { nativeChatHostStatusCopy } from '../notices/native-chat-notice-copy'
import { pressedStyle } from '../../../../theme/mobile-theme'
import { IMAGE_FILE_EXTENSIONS } from '../../../../../../src/shared/file-preview/image-mime-types'
import { mobileAttachmentExtension } from '../../../../files/attachments/mobile-attachment-file-kind'
import { shortAttachmentDisplayName } from '../../../../files/attachments/mobile-attachment-display-name'
import { MobileNativeChatFileChip } from '../message-actions/MobileNativeChatFileChip'
import {
  nativeChatTextWithoutUploadedFiles,
  nativeChatUploadedFilePaths
} from '../../../../../../src/shared/native-chat/attachments/native-chat-text-attachment-references'

/** A user message's text as Prose draws it: a Slack message's drawn form in place of the readable
 *  text the message keeps for copy. */
export function userProseText(
  message: Pick<NativeChatMessage, 'drawnMarkdown'>,
  text: string
): { text: string; slackMentions?: true } {
  if (message.drawnMarkdown !== undefined) {
    return { text: message.drawnMarkdown, slackMentions: true }
  }
  // Uploaded files draw as chips below the bubble, so their @path tokens stay out of the text.
  return {
    text:
      nativeChatUploadedFilePaths(text).length > 0 ? nativeChatTextWithoutUploadedFiles(text) : text
  }
}

export function Prose({
  rowKey,
  block,
  text,
  slackMentions = false,
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
  /** `text` is a Slack message's drawn form: its mention links draw as mentions. */
  slackMentions?: boolean
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
  const prose = useNativeChatProseText(fontScale)
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
      // A message of only uploaded files has no text to draw; its chips follow.
      if (text.trim() === '') {
        return null
      }
      return (
        <MobileNativeChatMarkdown
          content={text}
          tone="userMessage"
          slackMentions={slackMentions}
          rangeSelectable
          {...prose}
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
          {...prose}
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

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(
  IMAGE_FILE_EXTENSIONS.map((extension) => extension.slice(1)).concat([
    'heic',
    'heif',
    'avif',
    'tif',
    'tiff',
    'jfif'
  ])
)

function isNonImageFileRef(ref: string | undefined): ref is string {
  const extension = ref ? mobileAttachmentExtension(ref) : null
  return extension !== null && !IMAGE_EXTENSIONS.has(extension) && !/^data:/i.test(ref ?? '')
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
  // A pasted or picked document, video or archive is not an image: it gets a file chip, not a thumbnail.
  const fileRef = isNonImageFileRef(direct) ? direct : null
  const renderable = !fileRef && isRenderableImageUri(direct) ? direct : null
  const hostPath = !fileRef && !renderable && imageSource && block.path ? block.path : null
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
  if (fileRef) {
    return (
      <View style={styles.sentFiles}>
        <MobileNativeChatFileChip
          path={fileRef}
          pastedText={t('chat.textAttachmentPreview.pastedText', 'Pasted text')}
        />
      </View>
    )
  }
  if (hostPath && !read) {
    return <View style={styles.imageThumb} accessibilityLabel={label} />
  }
  if (!uri) {
    // The host could not read it as an image (an older upload of a document or video): name it as a file.
    const ref = block.path ?? block.url
    return ref ? (
      <View style={styles.sentFiles}>
        <MobileNativeChatFileChip
          path={ref}
          pastedText={t('chat.textAttachmentPreview.pastedText', 'Pasted text')}
        />
      </View>
    ) : (
      <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
        🖼 {block.alt ?? t('chat.nativeChatProse.image', 'image')}
      </Text>
    )
  }
  const caption = shortAttachmentDisplayName(block.path ?? block.url)
  const image = (
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
  return caption ? (
    <View style={styles.imageWithCaption}>
      {image}
      <Text style={styles.imageCaption} numberOfLines={1}>
        {caption}
      </Text>
    </View>
  ) : (
    image
  )
}
