import { isRenderableImageUri } from '../visual/mobile-native-chat-image-preview'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { FileText, Image as ImageIcon, X } from 'lucide-react-native'
import { colors, concentricRadius, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { formatPreviewByteLength } from '../../../files/mobile-file-preview-response'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'

const THUMB_SIZE = 58
// Items sit 12pt in from the composer box's edge (box padding plus strip padding).
const ITEM_RADIUS = concentricRadius(radii.floating, 12)

function composerFileMeta(
  file: Pick<PendingNativeChatFile, 'name' | 'mime' | 'byteLength'>,
  t: Translate
) {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]
  const subtype = /^[^/]+\/([a-z0-9]{1,8})$/i.exec(file.mime)?.[1]
  const type = (extension ?? subtype ?? t('chat.composerAttachments.file', 'File')).toUpperCase()
  return t('chat.composerAttachments.fileMeta', '{{type}} · {{size}}', {
    type,
    size: formatPreviewByteLength(file.byteLength)
  })
}

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
  useMobileColorScheme()
  const t = useMobileTranslation()
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
          {isRenderableImageUri(image.previewUri) ? (
            <Image
              source={{ uri: image.previewUri }}
              style={styles.thumbImage}
              resizeMode="cover"
            />
          ) : (
            <View
              style={styles.fileIcon}
              accessible
              accessibilityLabel={
                image.path.split(/[\\/]/).at(-1) ||
                t('chat.composerAttachments.attachedImage', 'Attached image')
              }
            >
              <ImageIcon size={17} color={colors.textSecondary} strokeWidth={2} />
            </View>
          )}
          {onRemoveImage ? (
            <RemoveBadge
              label={t('chat.composerAttachments.removeImage', 'Remove image')}
              onPress={() => onRemoveImage(image.id)}
            />
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
              {composerFileMeta(file, t)}
            </Text>
          </View>
          {file.path === null ? (
            <View
              style={styles.uploading}
              accessibilityLabel={t(
                'chat.composerAttachments.uploadingFile',
                'Uploading {{name}}',
                { name: file.name }
              )}
            >
              <ActivityIndicator size="small" color={colors.onAccent} />
            </View>
          ) : null}
          {onRemoveFile ? (
            <RemoveBadge
              label={t('chat.composerAttachments.removeFile', 'Remove {{name}}', {
                name: file.name
              })}
              onPress={() => onRemoveFile(file.id)}
            />
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}

function RemoveBadge({ label, onPress }: { label: string; onPress: () => void }) {
  useMobileColorScheme()
  return (
    <Pressable accessibilityLabel={label} style={styles.remove} onPress={onPress} hitSlop={8}>
      <X size={11} color={colors.textPrimary} strokeWidth={3} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
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
    borderRadius: ITEM_RADIUS,
    backgroundColor: colors.composerControl
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
    gap: 9,
    paddingLeft: 10,
    paddingRight: spacing.md,
    borderRadius: ITEM_RADIUS,
    backgroundColor: colors.composerControl
  },
  fileIcon: {
    width: 32,
    height: 36,
    borderRadius: concentricRadius(ITEM_RADIUS, 10),
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
    borderRadius: ITEM_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)'
  },
  // Keep most of the badge inside its item for Android touch delivery; strip padding protects the overhang.
  remove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 20,
    height: 20,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 2,
    borderColor: colors.composerSurface
  }
}))
