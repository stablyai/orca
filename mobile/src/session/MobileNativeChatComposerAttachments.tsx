import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { FileText, X } from 'lucide-react-native'
import { colors, motion, spacing, textStyles } from '../theme/mobile-theme'
import { pressTransition } from '../components/ui/transition-styles'
import { formatPreviewByteLength } from '../files/mobile-file-preview-response'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'

const THUMB_SIZE = 58

/** The card's second line: the file's type, then its size. */
function composerFileMeta(file: Pick<PendingNativeChatFile, 'name' | 'mime' | 'byteLength'>) {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]
  const subtype = /^[^/]+\/([a-z0-9]{1,8})$/i.exec(file.mime)?.[1]
  const type = (extension ?? subtype ?? 'File').toUpperCase()
  return `${type} · ${formatPreviewByteLength(file.byteLength)}`
}

/** Everything riding on the next send, inside the composer box above the text. */
export function MobileNativeChatComposerAttachments({
  images,
  files,
  onRemoveImage,
  onRemoveFile
}: {
  images: readonly PendingNativeChatImage[]
  files: readonly PendingNativeChatFile[]
  onRemoveImage?: (id: string) => void
  onRemoveFile?: (id: string) => void
}): React.JSX.Element | null {
  if (images.length === 0 && files.length === 0) {
    return null
  }
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
    >
      {images.map((image) => (
        <View key={image.id} style={styles.thumb}>
          <Image source={{ uri: image.previewUri }} style={styles.thumbImage} resizeMode="cover" />
          {onRemoveImage ? (
            <RemoveBadge label="Remove image" onPress={() => onRemoveImage(image.id)} />
          ) : null}
        </View>
      ))}
      {files.map((file) => (
        <View key={file.id} style={styles.fileCard}>
          <FileText size={20} color={colors.textSecondary} strokeWidth={2} />
          <View style={styles.fileText}>
            <Text style={styles.fileName} numberOfLines={1}>
              {file.name}
            </Text>
            <Text style={styles.fileMeta} numberOfLines={1}>
              {composerFileMeta(file)}
            </Text>
          </View>
          {file.path === null ? (
            <View style={styles.uploading} accessibilityLabel={`Uploading ${file.name}`}>
              <ActivityIndicator size="small" color={colors.textPrimary} />
            </View>
          ) : null}
          {onRemoveFile ? (
            <RemoveBadge label={`Remove ${file.name}`} onPress={() => onRemoveFile(file.id)} />
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}

/** A 22 pt badge on the item's corner, in a 36 pt touch box: the page ignores hitSlop. */
function RemoveBadge({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.removeTouch}
      onPress={onPress}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.remove,
            pressed && styles.removePressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <X size={12} color={colors.textPrimary} strokeWidth={3} />
        </View>
      )}
    </Pressable>
  )
}

// Concentric with the composer box: its 28 pt corner less the 10 pt it is padded in.
const ITEM_RADIUS = 18
const REMOVE_TOUCH = 36
const REMOVE_BADGE = 22
// How far the touch box overhangs the item's top-right corner.
const REMOVE_OVERHANG = 10

const styles = StyleSheet.create({
  strip: {
    flexGrow: 0,
    marginBottom: spacing.md
  },
  stripContent: {
    gap: spacing.sm,
    // Room for the remove badges, which overhang their item's top-right corner.
    paddingTop: REMOVE_OVERHANG,
    paddingLeft: 2,
    paddingRight: REMOVE_OVERHANG
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: ITEM_RADIUS,
    backgroundColor: colors.fill
  },
  thumbImage: {
    width: '100%',
    height: '100%',
    borderRadius: ITEM_RADIUS
  },
  fileCard: {
    height: THUMB_SIZE,
    minWidth: 140,
    maxWidth: 220,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    borderRadius: ITEM_RADIUS,
    backgroundColor: colors.fill
  },
  fileText: {
    flexShrink: 1,
    minWidth: 0
  },
  fileName: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textPrimary
  },
  fileMeta: {
    ...textStyles.caption,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  uploading: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: ITEM_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)'
  },
  // Most of the touch box sits inside its item, which Android needs to deliver the tap; the strip's
  // padding keeps the overhang from being clipped.
  removeTouch: {
    position: 'absolute',
    top: -REMOVE_OVERHANG,
    right: -REMOVE_OVERHANG,
    width: REMOVE_TOUCH,
    height: REMOVE_TOUCH,
    alignItems: 'center',
    justifyContent: 'center'
  },
  remove: {
    width: REMOVE_BADGE,
    height: REMOVE_BADGE,
    borderRadius: REMOVE_BADGE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 2,
    borderColor: colors.composerSurface
  },
  removePressed: {
    backgroundColor: colors.borderSubtle,
    transform: [{ scale: motion.pressedIconScale }]
  }
})
