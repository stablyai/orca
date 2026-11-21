// A comment's images and files on the phone, as the desktop draws them: images fitted to the card (one
// at its own shape, two side by side, more in rows of three; past six, five and a "+N"), read from the
// bot's host, opening the image viewer over all of them; files as buttons that open like file links.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Image, Pressable, Text, View, type LayoutChangeEvent } from 'react-native'
import {
  botItemCommentImages,
  type BotItemCommentImage
} from '../../../../src/shared/bots/bot-items'
import { botItemCommentFiles } from '../../../../src/shared/bots/bot-item-comment-files'
import { stripSentImagePromptMarkers } from '../../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { chatTextAttachmentName } from '../../../../src/shared/native-chat/attachments/native-chat-text-attachment-references'
import { MobileImageViewer } from '../../files/media/presentation/MobileImageViewer'
import { readHostChatImage } from '../../session/native-chat/visual/mobile-native-chat-image-preview'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { colors, feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

const SHOWN = 5
const GAP = 6
const ONE_MAX_HEIGHT = 220
const BLANK_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

type Reads = {
  uris: Record<string, string | null>
  read: (path: string) => void
}

/** Each image read from the host once, for its tile and the viewer alike. */
function useHostImages(client: RpcClient | null): Reads {
  const [uris, setUris] = useState<Record<string, string | null>>({})
  const started = useRef(new Set<string>())
  const unmounted = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    unmounted.current = controller
    return () => controller.abort()
  }, [])
  const read = useCallback(
    (path: string) => {
      if (!client || started.current.has(path)) {
        return
      }
      started.current.add(path)
      const { signal } = unmounted.current
      // Store paths read from the attachment store, which needs no workspace.
      void readHostChatImage({ client, worktreeId: '' }, path, signal).then((uri) => {
        if (!signal.aborted) {
          // A failed read may be tried again by the next tile or viewer that asks.
          if (uri === null) {
            started.current.delete(path)
          }
          setUris((current) => ({ ...current, [path]: uri }))
        }
      })
    },
    [client]
  )
  return { uris, read }
}

function Tile({
  image,
  reads,
  width,
  height,
  onOpen
}: {
  image: BotItemCommentImage
  reads: Reads
  width: number
  height: number | null
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  const [aspect, setAspect] = useState<number | null>(null)
  const { read } = reads
  useEffect(() => read(image.path), [read, image.path])
  const uri = reads.uris[image.path]
  // One image keeps its own shape, up to the card's width and 220 pt tall.
  const size =
    height !== null
      ? { width, height }
      : aspect
        ? aspect * ONE_MAX_HEIGHT > width
          ? { width, height: width / aspect }
          : { width: aspect * ONE_MAX_HEIGHT, height: ONE_MAX_HEIGHT }
        : { width: Math.min(width, 160), height: 120 }
  if (!uri) {
    return (
      <View style={[styles.tile, size, styles.placeholder]} accessibilityLabel={image.name}>
        {uri === null ? (
          <Text style={styles.caption} numberOfLines={1}>
            {image.name}
          </Text>
        ) : null}
      </View>
    )
  }
  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [styles.tile, size, pressed && { opacity: feedback.pressedOpacity }]}
      accessibilityRole="imagebutton"
      accessibilityLabel={image.name}
      accessibilityHint={t('chat.nativeChatProse.openImageHint', 'Opens the image full size')}
    >
      <Image
        source={{ uri }}
        style={styles.image}
        resizeMode="cover"
        onLoad={({ nativeEvent }) =>
          nativeEvent.source.height > 0 &&
          setAspect(nativeEvent.source.width / nativeEvent.source.height)
        }
      />
    </Pressable>
  )
}

function Viewer({
  images,
  index,
  reads,
  onIndex
}: {
  images: readonly BotItemCommentImage[]
  index: number
  reads: Reads
  onIndex: (index: number | null) => void
}) {
  const image = images[index]!
  const { read } = reads
  // The neighbours too, so a step lands on a read image. Keyed by path, not the images array (fresh
  // each render): a read that fails re-renders, and must not ask again until the viewer steps.
  const nearby = [index - 1, index, index + 1]
    .flatMap((near) => images[near]?.path ?? [])
    .join('\0')
  useEffect(() => {
    for (const path of nearby ? nearby.split('\0') : []) {
      read(path)
    }
  }, [read, index, nearby])
  // Shown until the next image's bytes arrive, so a step never closes the viewer.
  const [shown, setShown] = useState<string | null>(null)
  const fresh = reads.uris[image.path]
  if (fresh && fresh !== shown) {
    setShown(fresh)
  }
  // A failed read shows an empty stage under its name, never the last image.
  const uri = fresh === null ? BLANK_IMAGE : (fresh ?? shown)
  if (!uri) {
    return null
  }
  const many = images.length > 1
  return (
    <MobileImageViewer
      uri={uri}
      label={image.name}
      onClose={() => onIndex(null)}
      {...(many
        ? {
            onPrevious: index > 0 ? () => onIndex(index - 1) : null,
            onNext: index < images.length - 1 ? () => onIndex(index + 1) : null
          }
        : {})}
    />
  )
}

/** A comment's words without the [Image #N] its send wrote for its images, nor its files' `@path`s, as
 *  desktop and chat show them. */
export function mobileBotItemCommentWords(data: Record<string, unknown>): string {
  const text = typeof data.text === 'string' ? data.text : ''
  return botItemCommentFiles(stripSentImagePromptMarkers(text, botItemCommentImages(data).length))
    .words
}

export type MobileBotItemAttachmentSource = {
  /** The bot's host, which comment images are read from. */
  client: RpcClient | null
  onOpenFile?: (path: string) => void
}

/** `children` (the comment's words), then its images, then its files as links. */
export function MobileBotItemCommentAttachments({
  data,
  client,
  onOpenFile,
  children
}: MobileBotItemAttachmentSource & {
  data: Record<string, unknown>
  children?: ReactNode
}) {
  useMobileColorScheme()
  const images = botItemCommentImages(data)
  const { files } = botItemCommentFiles(typeof data.text === 'string' ? data.text : '')
  const t = useMobileTranslation()
  const reads = useHostImages(client)
  const [width, setWidth] = useState(0)
  const [all, setAll] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  if (images.length === 0 && files.length === 0) {
    return children
  }
  const folded = images.length > SHOWN + 1 && !all
  const shown = folded ? images.slice(0, SHOWN) : images
  const columns = images.length === 1 ? 1 : images.length === 2 ? 2 : 3
  const cell = width > 0 ? (width - GAP * (columns - 1)) / columns : 0
  const height = columns === 1 ? null : columns === 2 ? (cell * 3) / 4 : cell
  return (
    <View>
      {children}
      {images.length > 0 ? (
        <View
          style={styles.grid}
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        >
          {cell > 0
            ? shown.map((image, index) => (
                <View key={image.path} style={{ width: cell }}>
                  <Tile
                    image={image}
                    reads={reads}
                    width={cell}
                    height={height}
                    onOpen={() => setViewing(index)}
                  />
                  {columns < 3 ? (
                    <Text style={styles.caption} numberOfLines={1}>
                      {image.name}
                    </Text>
                  ) : null}
                </View>
              ))
            : null}
          {cell > 0 && images.length > SHOWN + 1 ? (
            <Pressable
              onPress={() => setAll(folded)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.tile,
                styles.placeholder,
                { width: cell, height: cell },
                pressed && { opacity: feedback.pressedOpacity }
              ]}
            >
              <Text style={styles.more}>
                {folded
                  ? `+${images.length - SHOWN}`
                  : t('bots.items.comment.showLess', 'Show less')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={styles.files}>
          {files.map((path) => {
            const name = chatTextAttachmentName(
              path,
              t('components.native-chat.composer.pastedTextLabel', 'Pasted text')
            )
            return (
              <Text
                key={path}
                onPress={onOpenFile ? () => onOpenFile(path) : undefined}
                accessibilityRole="link"
                accessibilityLabel={name}
                style={styles.fileName}
                numberOfLines={1}
              >
                {name}
              </Text>
            )
          })}
        </View>
      ) : null}
      {viewing !== null ? (
        <Viewer images={images} index={viewing} reads={reads} onIndex={setViewing} />
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, marginTop: spacing.xs },
  tile: {
    borderRadius: radii.surface,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  placeholder: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs },
  image: { width: '100%', height: '100%' },
  caption: { marginTop: 2, fontSize: typography.metaSize, color: colors.textMuted },
  more: { fontSize: typography.metaSize, color: colors.textMuted },
  files: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: spacing.md,
    rowGap: 4,
    marginTop: spacing.xs
  },
  fileName: {
    flexShrink: 1,
    fontSize: 13,
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  }
}))
