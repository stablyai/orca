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
import { colors, radii, spacing } from '../theme/mobile-theme'
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
          <View style={styles.fileIcon}>
            <FileText size={17} color={colors.textSecondary} strokeWidth={2} />
          </View>
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

function RemoveBadge({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityLabel={label} style={styles.remove} onPress={onPress} hitSlop={8}>
      <X size={11} color={colors.textPrimary} strokeWidth={3} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  strip: {
    flexGrow: 0,
    marginBottom: 10
  },
  stripContent: {
    gap: spacing.sm,
    // Room for the remove badges, which overhang their item's top-right corner.
    paddingTop: 5,
    paddingLeft: 2,
    paddingRight: 5
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radii.composerItem,
    backgroundColor: colors.composerControl
  },
  thumbImage: {
    width: '100%',
    height: '100%',
    borderRadius: radii.composerItem
  },
  fileCard: {
    height: THUMB_SIZE,
    minWidth: 140,
    maxWidth: 220,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingLeft: 10,
    paddingRight: spacing.md,
    borderRadius: radii.composerItem,
    backgroundColor: colors.composerControl
  },
  fileIcon: {
    width: 32,
    height: 36,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  fileText: {
    flexShrink: 1,
    minWidth: 0
  },
  fileName: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '500'
  },
  fileMeta: {
    color: colors.textMuted,
    fontSize: 11.5,
    marginTop: 1
  },
  uploading: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radii.composerItem,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)'
  },
  // Most of the badge sits inside its item, which Android needs to deliver the tap; the strip's
  // padding keeps the 5pt overhang from being clipped.
  remove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 2,
    borderColor: colors.composerSurface
  }
})
