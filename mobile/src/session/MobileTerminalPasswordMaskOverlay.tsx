import { Pressable, Text, View } from 'react-native'
import { Eye, EyeOff } from 'lucide-react-native'
import { maskTerminalLiveInputText } from '../terminal/terminal-password-prompt'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { themedStyleSheet } from '../theme/themed-styles'

type MobileTerminalPasswordMaskOverlayProps = {
  readonly value: string
  readonly masked: boolean
  readonly onToggleMask: () => void
  readonly showToggle?: boolean
}

export function MobileTerminalPasswordMaskOverlay({
  value,
  masked,
  onToggleMask,
  showToggle = true
}: MobileTerminalPasswordMaskOverlayProps) {
  useMobileColorScheme()
  const maskedText = masked && value.length > 0 ? maskTerminalLiveInputText(value) : ''
  const shouldRenderToggle = showToggle

  if (!maskedText && !shouldRenderToggle) {
    return null
  }

  return (
    <>
      {maskedText ? (
        <View style={styles.maskOverlay} pointerEvents="none">
          <Text style={styles.maskText} numberOfLines={1} ellipsizeMode="head">
            {maskedText}
          </Text>
        </View>
      ) : null}
      {shouldRenderToggle ? (
        <Pressable
          style={styles.toggleButton}
          onPress={onToggleMask}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ selected: masked }}
        >
          {masked ? (
            <EyeOff size={15} color={colors.accentBlue} strokeWidth={2.2} />
          ) : (
            <Eye size={15} color={colors.textSecondary} strokeWidth={2.2} />
          )}
        </Pressable>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  maskOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 30,
    bottom: 0,
    justifyContent: 'center',
    paddingLeft: spacing.md,
    borderRadius: radii.input
  },
  maskText: {
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    fontFamily: typography.monoFamily,
    letterSpacing: 1
  },
  toggleButton: {
    position: 'absolute',
    right: 4,
    top: 3,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center'
  }
}))
