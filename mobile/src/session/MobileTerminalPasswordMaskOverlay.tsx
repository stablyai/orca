import { Pressable, Text, View } from 'react-native'
import { Eye, EyeOff } from 'lucide-react-native'
import { COMPOSER_TEXT_SIZE } from '../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { maskTerminalLiveInputText } from '../terminal/terminal-password-prompt'
import { colors, radii, typography } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { themedStyleSheet } from '../theme/themed-styles'

type MobileTerminalPasswordMaskToggleProps = {
  readonly masked: boolean
  readonly onToggleMask: () => void
}

export function MobileTerminalPasswordMaskToggle({
  masked,
  onToggleMask
}: MobileTerminalPasswordMaskToggleProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      style={styles.trailingToggleButton}
      onPress={onToggleMask}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        masked
          ? t('session.terminalPasswordMask.showInput', 'Show input')
          : t('session.terminalPasswordMask.hideInput', 'Hide input')
      }
      accessibilityState={{ selected: masked }}
    >
      {masked ? (
        <EyeOff size={16} color={colors.accentBlue} strokeWidth={2.1} />
      ) : (
        <Eye size={16} color={colors.textSecondary} strokeWidth={2.1} />
      )}
    </Pressable>
  )
}

type MobileTerminalPasswordMaskOverlayProps = {
  readonly value: string
  readonly masked: boolean
  readonly onToggleMask?: () => void
  readonly showToggle?: boolean
}

export function MobileTerminalPasswordMaskOverlay({
  value,
  masked,
  onToggleMask,
  showToggle = false
}: MobileTerminalPasswordMaskOverlayProps) {
  useMobileColorScheme()
  const maskedText = masked && value.length > 0 ? maskTerminalLiveInputText(value) : ''
  const shouldRenderToggle = Boolean(showToggle && onToggleMask)

  if (!maskedText && !shouldRenderToggle) {
    return null
  }

  return (
    <>
      {maskedText ? (
        <View
          style={[styles.maskOverlay, shouldRenderToggle && styles.maskOverlayWithToggle]}
          pointerEvents="none"
        >
          <Text style={styles.maskText} numberOfLines={1} ellipsizeMode="head">
            {maskedText}
          </Text>
        </View>
      ) : null}
      {shouldRenderToggle && onToggleMask ? (
        <View style={styles.inlineToggleSlot}>
          <MobileTerminalPasswordMaskToggle masked={masked} onToggleMask={onToggleMask} />
        </View>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  maskOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    borderRadius: radii.control
  },
  maskOverlayWithToggle: {
    right: 30
  },
  maskText: {
    color: colors.textPrimary,
    fontSize: COMPOSER_TEXT_SIZE,
    fontFamily: typography.monoFamily,
    letterSpacing: 1
  },
  trailingToggleButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center'
  },
  inlineToggleSlot: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center'
  }
}))
