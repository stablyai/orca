import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native'
import { Check } from 'lucide-react-native'
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
  onPreviewLayout,
  selected,
  multi,
  disabled,
  onPress
}: {
  label: string
  description?: string
  /** Shown under the row while it is selected, as the agent wrote it. */
  preview?: string
  /** The preview's edges in the card's scroll content; the row renders as its direct children. */
  onPreviewLayout?: (top: number, bottom: number) => void
  selected: boolean
  multi?: boolean
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const row = (
    <Pressable
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected, disabled }}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
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
  // One root shape whether or not the preview shows, so selecting never remounts the row.
  return (
    <>
      {row}
      {preview && selected ? (
        <View
          style={styles.preview}
          onLayout={(event: LayoutChangeEvent) => {
            const { y, height } = event.nativeEvent.layout
            onPreviewLayout?.(y, y + height)
          }}
        >
          <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
            {/* Mockups are drawn in columns, so they scroll sideways instead of wrapping at phone width. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text selectable style={styles.previewText}>
                {preview}
              </Text>
            </ScrollView>
          </ScrollView>
        </View>
      ) : null}
    </>
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
  preview: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: concentricRadius(radii.surface, spacing.xs),
    padding: spacing.sm,
    marginBottom: spacing.xs,
    maxHeight: 220
  },
  previewText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  }
}))
