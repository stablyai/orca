import type { LucideIcon } from 'lucide-react-native'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { MobilePendingButton } from '../controls/MobilePendingButton'
import { sheetPrimaryButtonStylesSheet } from './SheetPrimaryButton'

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
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const sheetPrimaryButtonStyles = useThemedStyles(sheetPrimaryButtonStylesSheet)
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

const stylesSheet = themedStyleSheet((colors) => ({
  button: { height: 44, backgroundColor: 'transparent' },
  label: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' }
}))
