import { Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { MobileNativeChatOptionThumbnail } from './MobileNativeChatOptionThumbnail'
import {
  colors,
  concentricRadius,
  radii,
  spacing,
  typography,
  pressedStyle
} from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

export function MobileNativeChatAskOptionRow({
  label,
  description,
  preview,
  onPreview,
  selected,
  multi,
  disabled,
  onPress
}: {
  label: string
  description?: string
  /** Read-only inspection is separate from choosing the option. */
  preview?: string
  onPreview?: () => void
  selected: boolean
  multi?: boolean
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const hasPreview = Boolean(preview && onPreview)
  const row = (
    <Pressable
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected, disabled }}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        hasPreview && styles.optionWithPreview,
        pressed && pressedStyle
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      {/* Multi-select reads as a checkbox (square); single-select as a radio (circle). */}
      <View
        style={[
          styles.check,
          multi ? styles.checkSquare : styles.checkCircle,
          selected && styles.checkOn
        ]}
      >
        {selected ? <Check size={12} color={colors.bgBase} strokeWidth={3} /> : null}
      </View>
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{label}</Text>
        {description ? (
          <Text style={styles.optionDescription} numberOfLines={3}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
  return hasPreview ? (
    <View style={[styles.optionCard, selected && styles.optionSelected]}>
      {row}
      <View style={styles.previewInset}>
        <MobileNativeChatOptionThumbnail label={label} preview={preview!} onPress={onPreview!} />
      </View>
    </View>
  ) : (
    row
  )
}

const styles = themedStyleSheet(() => ({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: concentricRadius(radii.surface, spacing.xs),
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    marginBottom: spacing.xs
  },
  optionSelected: {
    borderColor: colors.statusGreen
  },
  check: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkCircle: {
    borderRadius: radii.pill
  },
  checkSquare: {
    borderRadius: radii.mark
  },
  checkOn: {
    backgroundColor: colors.statusGreen,
    borderColor: colors.statusGreen
  },
  optionBody: {
    flex: 1,
    gap: 2
  },
  optionLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  optionDescription: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  optionCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: concentricRadius(radii.surface, spacing.xs),
    backgroundColor: colors.bgRaised,
    marginBottom: spacing.xs
  },
  optionWithPreview: { borderWidth: 0, marginBottom: 0 },
  previewInset: {
    marginLeft: 18 + spacing.sm * 2,
    marginRight: spacing.sm,
    marginBottom: spacing.sm
  }
}))
