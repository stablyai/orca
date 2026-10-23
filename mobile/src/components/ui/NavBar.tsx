import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing, textStyles } from '../../theme/mobile-theme'
import { IconButton } from './IconButton'
import { slideTransition } from './transition-styles'

type NavBarProps = {
  /** Centred headline. Hidden while a large title below the bar is still on screen. */
  title?: string
  subtitle?: string
  subtitleColor?: string
  onBack?: () => void
  backAccessibilityLabel?: string
  /** Replaces the back button, e.g. a close button on a docked panel. */
  leading?: ReactNode
  /** At most two IconButtons; anything more belongs in an overflow menu. */
  trailing?: ReactNode
  /** False while a LargeTitle under the bar still shows the title. */
  titleVisible?: boolean
  /** Draws the hairline once content scrolls under the bar. */
  scrolled?: boolean
  testID?: string
}

/** The one navigation bar: back on the left, a centred title, up to two actions on the right. */
export function NavBar({
  title,
  subtitle,
  subtitleColor,
  onBack,
  backAccessibilityLabel = 'Back',
  leading,
  trailing,
  titleVisible = true,
  scrolled = false,
  testID
}: NavBarProps) {
  return (
    <View style={[styles.bar, scrolled && styles.scrolled]} testID={testID}>
      <View style={styles.side}>
        {leading ??
          (onBack ? (
            <IconButton
              icon={ChevronLeft}
              accessibilityLabel={backAccessibilityLabel}
              onPress={onBack}
              iconSize={22}
            />
          ) : null)}
      </View>
      <View
        style={[styles.center, titleVisible ? styles.shown : styles.hidden, slideTransition]}
        accessibilityElementsHidden={!titleVisible}
      >
        {title !== undefined ? (
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
        {subtitle !== undefined ? (
          <Text
            style={[styles.subtitle, subtitleColor !== undefined && { color: subtitleColor }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={[styles.side, styles.trailing]}>{trailing}</View>
    </View>
  )
}

type LargeTitleProps = {
  title: string
  /** One line under the title, e.g. a status dot and "Connected · 6 workspaces". */
  subtitle?: ReactNode
}

/** A hub screen's 30 pt title, scrolled with the content; the bar's title fades in once it leaves. */
export function LargeTitle({ title, subtitle }: LargeTitleProps) {
  return (
    <View style={styles.large}>
      <Text style={styles.largeTitle} numberOfLines={2} accessibilityRole="header">
        {title}
      </Text>
      {subtitle}
    </View>
  )
}

/** Scroll distance after which the large title has left and the bar shows its own. */
export const LARGE_TITLE_COLLAPSE_OFFSET = 40

const styles = StyleSheet.create({
  bar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent'
  },
  scrolled: { borderBottomColor: colors.separator },
  side: { minWidth: 92, flexDirection: 'row', alignItems: 'center' },
  trailing: { justifyContent: 'flex-end' },
  center: { flex: 1, minWidth: 0, alignItems: 'center' },
  shown: { opacity: 1 },
  hidden: { opacity: 0 },
  title: { ...textStyles.headline, color: colors.textPrimary },
  subtitle: { ...textStyles.caption, color: colors.textSecondary },
  large: { paddingHorizontal: spacing.lg + 4, paddingBottom: spacing.sm, gap: 2 },
  largeTitle: { ...textStyles.largeTitle, color: colors.textPrimary }
})
