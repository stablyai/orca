import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'

/** The removable-thumbnail strip for images picked-and-uploaded but not yet
 *  sent, shown above the composer bar. */
export function MobileNativeChatComposerAttachments({
  attachments,
  onRemoveAttachment
}: {
  attachments: readonly PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.attachmentStrip}
      contentContainerStyle={styles.attachmentStripContent}
    >
      {attachments.map((attachment) => (
        <View key={attachment.id} style={styles.attachmentThumb}>
          <Image
            source={{ uri: attachment.previewUri }}
            style={styles.attachmentImage}
            resizeMode="cover"
          />
          {onRemoveAttachment ? (
            <Pressable
              accessibilityLabel="Remove image"
              style={styles.attachmentRemove}
              onPress={() => onRemoveAttachment(attachment.id)}
              hitSlop={8}
            >
              <X size={12} color={colors.textPrimary} strokeWidth={2.6} />
            </Pressable>
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  attachmentStrip: {
    maxHeight: 76,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  attachmentStripContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  attachmentThumb: {
    width: 60,
    height: 60,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  attachmentImage: {
    width: '100%',
    height: '100%',
    borderRadius: radii.button
  },
  attachmentRemove: {
    // Inset inside the thumb: Android drops touches outside the parent's bounds,
    // so an overhanging badge would lose part of its tap target.
    position: 'absolute',
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  }
})
