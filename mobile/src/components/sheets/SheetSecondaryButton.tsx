import type { LucideIcon } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobilePendingButton } from '../controls/MobilePendingButton'
import { sheetPrimaryButtonStyles } from './SheetPrimaryButton'

/** The quiet choice under a SheetPrimaryButton, e.g. "Paste code" under "Scan code", or Cancel. */
export function SheetSecondaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  icon: Icon,
  accessibilityLabel
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  icon?: LucideIcon
  accessibilityLabel?: string
}) {
  useMobileColorScheme()
  return (
    <MobilePendingButton
      label={label}
      icon={Icon ? <Icon size={17} color={colors.textSecondary} strokeWidth={2} /> : undefined}
      style={[sheetPrimaryButtonStyles.button, styles.button]}
      labelStyle={styles.label}
      spinnerColor={colors.textSecondary}
      pending={busy}
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
    />
  )
}

const styles = themedStyleSheet(() => ({
  button: { height: 44, backgroundColor: 'transparent' },
  label: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' }
}))
