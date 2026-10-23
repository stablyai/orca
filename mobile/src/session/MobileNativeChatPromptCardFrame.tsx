import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityRole,
  type AccessibilityState
} from 'react-native'
import { Check, type LucideIcon } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'
import { pressTransition } from '../components/ui/transition-styles'
import { COMPOSER_TRAY_TUCK, composerTrayStyles } from './mobile-native-chat-composer-styles'

/**
 * The one prompt card: a tray layer tucked into the composer's top edge, with an icon and a title
 * when it has them, the header's Cancel or Collapse, and the card's own body below.
 */
export function MobileNativeChatPromptCardFrame({
  icon: Icon,
  title,
  titleTestID,
  headerAction,
  children,
  testID,
  bodyStyle = 'padded'
}: {
  icon?: LucideIcon
  title?: string
  titleTestID?: string
  headerAction?: ReactNode
  children: ReactNode
  testID?: string
  /** `flush` leaves the edges to the body, e.g. the Ask wizard's tabs and footer. */
  bodyStyle?: 'padded' | 'flush'
}): React.JSX.Element {
  return (
    <View style={[composerTrayStyles.layer, styles.shrink]}>
      <View
        testID={testID}
        style={[
          composerTrayStyles.panel,
          styles.shrink,
          bodyStyle === 'padded' ? styles.padded : styles.flush
        ]}
      >
        {title !== undefined ? (
          <View style={styles.header}>
            {Icon ? (
              <Icon size={18} color={colors.textSecondary} strokeWidth={2.2} style={styles.icon} />
            ) : null}
            <Text
              testID={titleTestID}
              style={styles.title}
              numberOfLines={3}
              ellipsizeMode="tail"
              accessibilityRole="header"
            >
              {title}
            </Text>
            {headerAction}
          </View>
        ) : null}
        {children}
      </View>
    </View>
  )
}

/**
 * A 48 pt answer row, the same in every prompt: a radio or checkbox mark when picking takes a
 * second step, nothing when a tap answers, and a spinner on the row whose answer is on its way.
 */
export function MobileNativeChatPromptOption({
  label,
  description,
  mark = null,
  selected = false,
  busy = false,
  disabled = false,
  onPress,
  accessibilityRole = 'button',
  accessibilityState
}: {
  label: string
  description?: string
  mark?: 'radio' | 'checkbox' | null
  selected?: boolean
  busy?: boolean
  disabled?: boolean
  onPress: () => void
  accessibilityRole?: AccessibilityRole
  accessibilityState?: AccessibilityState
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled, busy, ...accessibilityState }}
      disabled={disabled}
      onPress={onPress}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.option,
            selected && styles.optionSelected,
            pressed && !disabled && styles.optionPressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {mark ? (
            <View
              style={[
                styles.mark,
                mark === 'radio' ? styles.markRadio : styles.markCheckbox,
                selected && styles.markOn
              ]}
            >
              {selected ? <Check size={14} color={colors.onPrimary} strokeWidth={3} /> : null}
            </View>
          ) : null}
          <View style={styles.optionBody}>
            <Text style={styles.optionLabel}>{label}</Text>
            {description ? (
              <Text style={styles.optionDescription} numberOfLines={3}>
                {description}
              </Text>
            ) : null}
          </View>
          {busy ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
        </View>
      )}
    </Pressable>
  )
}

export const promptCardStyles = StyleSheet.create({
  /** Options stacked with a little air between them. */
  options: { gap: 6 },
  /** The card's body copy: what the agent wants, at a size meant to be read before answering. */
  detail: { ...textStyles.callout, color: colors.textSecondary },
  detailLabel: { fontWeight: '500', color: colors.textPrimary }
})

const styles = StyleSheet.create({
  shrink: { flexShrink: 1, minHeight: 0 },
  padded: {
    paddingTop: spacing.md + 2,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md + COMPOSER_TRAY_TUCK,
    gap: spacing.md
  },
  flush: { paddingBottom: COMPOSER_TRAY_TUCK },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm + 2,
    flexShrink: 0
  },
  icon: { marginTop: 2 },
  title: {
    ...textStyles.body,
    fontWeight: '600',
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary
  },
  option: {
    minHeight: MIN_TOUCH_TARGET + 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.field,
    backgroundColor: colors.fill
  },
  optionSelected: { backgroundColor: colors.fillPressed },
  optionPressed: { backgroundColor: colors.fillPressed },
  optionBody: { flex: 1, minWidth: 0, gap: 2 },
  optionLabel: { ...textStyles.body, color: colors.textPrimary },
  optionDescription: { ...textStyles.footnote, color: colors.textSecondary },
  mark: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  markRadio: { borderRadius: 11 },
  markCheckbox: { borderRadius: 6 },
  markOn: { backgroundColor: colors.primary, borderColor: colors.primary }
})
