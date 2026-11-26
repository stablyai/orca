import type { LucideIcon } from 'lucide-react-native'
import { colors, feedback, radii, spacing } from '../../theme/mobile-theme'
import { MobilePendingButton } from '../controls/MobilePendingButton'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

type SheetPrimaryButtonProps = {
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  testID?: string
  /** Merge keeps desktop's merge green for the one action that lands a pull request. */
  tone?: 'default' | 'merge'
  size?: 'default' | 'compact'
  icon?: LucideIcon
}

/** A sheet's full-width commit at its foot, e.g. "Create worktree". */
export function SheetPrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  testID,
  tone = 'default',
  size = 'default',
  icon: Icon
}: SheetPrimaryButtonProps) {
  useMobileColorScheme()
  const foreground = tone === 'merge' ? colors.onMergeGreen : colors.bgBase
  return (
    <MobilePendingButton
      label={label}
      icon={Icon ? <Icon size={17} color={foreground} strokeWidth={2.2} /> : undefined}
      style={[
        sheetPrimaryButtonStyles.button,
        tone === 'merge' && sheetPrimaryButtonStyles.merge,
        size === 'compact' && sheetPrimaryButtonStyles.compact
      ]}
      labelStyle={[
        sheetPrimaryButtonStyles.label,
        size === 'compact' && sheetPrimaryButtonStyles.compactLabel,
        { color: foreground }
      ]}
      spinnerColor={foreground}
      pending={busy}
      disabled={disabled}
      onPress={onPress}
      hitSlop={size === 'compact' ? 8 : undefined}
      testID={testID}
    />
  )
}

export const sheetPrimaryButtonStyles = themedStyleSheet(() => ({
  button: {
    height: 48,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  compact: { height: 32, paddingHorizontal: spacing.md },
  compactLabel: { fontSize: 13 },
  merge: { backgroundColor: colors.mergeGreen },
  pressed: { opacity: feedback.pressedOpacity },
  label: { color: colors.bgBase, fontSize: 15, fontWeight: '600' }
}))
