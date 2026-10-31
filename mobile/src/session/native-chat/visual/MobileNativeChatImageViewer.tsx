import { Image, Modal, Pressable, ScrollView, View } from 'react-native'
import { X } from 'lucide-react-native'
import { useWindowSafeAreaInsets } from '../../../layout/side-safe-area'
import { colors, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'

export function MobileNativeChatImageViewer({
  uri,
  label,
  onClose
}: {
  uri: string
  label: string
  onClose: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useWindowSafeAreaInsets()
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <ScrollView
          contentContainerStyle={styles.stage}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            source={{ uri }}
            style={styles.image}
            resizeMode="contain"
            accessibilityLabel={label}
          />
        </ScrollView>
        <Pressable
          style={[styles.close, { top: insets.top + spacing.sm }]}
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('chat.nativeChatImageViewer.closeImage', 'Close image')}
        >
          <X size={22} color={colors.textPrimary} strokeWidth={2} />
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = themedStyleSheet(() => ({
  backdrop: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  stage: {
    flexGrow: 1
  },
  image: {
    flex: 1,
    width: '100%'
  },
  close: {
    position: 'absolute',
    right: spacing.lg,
    padding: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  }
}))
