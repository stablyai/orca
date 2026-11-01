import { Modal, Pressable, View } from 'react-native'
import { X } from 'lucide-react-native'
import { useWindowSafeAreaInsets } from '../../../layout/side-safe-area'
import { colors, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { PanZoomSize } from '../../../../../src/shared/pan-zoom-view'
import { MobilePanZoomImage } from '../../../components/MobilePanZoomImage'

/** Full-screen pinch, drag and double-tap zoom for chat and Markdown images, and Mermaid diagrams. */
export function MobileNativeChatImageViewer({
  uri,
  label,
  size,
  upscale,
  onClose
}: {
  uri: string
  label: string
  /** A drawing's own size; raster images measure themselves. */
  size?: PanZoomSize | null
  /** Let fit enlarge a vector past its natural size. */
  upscale?: boolean
  onClose: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useWindowSafeAreaInsets()
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.stage}>
          <MobilePanZoomImage uri={uri} label={label} size={size} upscale={upscale} />
        </View>
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
    flex: 1
  },
  close: {
    position: 'absolute',
    right: spacing.lg,
    padding: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  }
}))
