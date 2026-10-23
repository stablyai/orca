import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'
import { colors, MIN_TOUCH_TARGET, spacing } from '../theme/mobile-theme'

/** How far a row's pressed fill reaches past its text, so the text keeps the column's edge. */
export const DISCLOSURE_BLEED = spacing.sm

/** A disclosure's trailing chevron: points right when closed, down when open, and eases between. */
export function MobileNativeChatChevron({
  open,
  fontScale = 1
}: {
  open: boolean
  fontScale?: number
}): React.JSX.Element {
  return (
    <View style={[styles.chevron, open && styles.chevronOpen, slideTransition]}>
      <ChevronRight size={16 * fontScale} color={colors.textMuted} strokeWidth={2.2} />
    </View>
  )
}

/** The chat's one disclosure row: 44 pt, a pressed fill, and a trailing chevron that turns as it
 *  opens. Tool runs and lines, reasoning, subagents, turn bars and diff cards all use it. */
export function MobileNativeChatDisclosureRow({
  onPress,
  expanded,
  disabled = false,
  fontScale = 1,
  accessibilityLabel,
  accessibilityLiveRegion,
  style,
  children
}: {
  onPress?: () => void
  /** Draws the chevron; undefined for a row that opens nothing. */
  expanded?: boolean
  disabled?: boolean
  fontScale?: number
  accessibilityLabel?: string
  accessibilityLiveRegion?: 'polite'
  style?: StyleProp<ViewStyle>
  children: ReactNode
}): React.JSX.Element {
  const content = (
    <>
      <View style={styles.main}>{children}</View>
      {expanded !== undefined && !disabled ? (
        <MobileNativeChatChevron open={expanded} fontScale={fontScale} />
      ) : null}
    </>
  )
  if (!onPress) {
    return (
      <View
        style={[styles.row, style]}
        accessibilityLabel={accessibilityLabel}
        accessibilityLiveRegion={accessibilityLiveRegion}
      >
        {content}
      </View>
    )
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={expanded !== undefined && !disabled ? { expanded } : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion={accessibilityLiveRegion}
      style={({ pressed }) => [
        styles.row,
        style,
        pressed && !disabled && styles.pressed,
        pressed ? pressTransition.pressed : pressTransition.rest
      ]}
    >
      {content}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: -DISCLOSURE_BLEED,
    paddingHorizontal: DISCLOSURE_BLEED,
    paddingVertical: 6,
    borderRadius: 12
  },
  pressed: {
    backgroundColor: colors.fill
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  chevron: {
    flexShrink: 0
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }]
  }
})
