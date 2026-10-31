import type { ReactNode } from 'react'
import { Animated, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export const NAV_BAR_HEIGHT = 52

type NavBarProps = {
  /** Usually the back button; a side-panel or close button where a screen has no back. */
  leading?: ReactNode
  title?: string
  /** One short line under the title: host, workspace, or a status. */
  subtitle?: ReactNode
  /** Replaces the title block, e.g. the session title that opens its details card. */
  center?: ReactNode
  /** At most two NavBarButtons; anything more belongs in the ⋯ menu. */
  trailing?: ReactNode
  /** A switcher or filter row under the title; it shares the bar's band, so the list slides under both. */
  accessory?: ReactNode
  style?: StyleProp<ViewStyle>
  /** From useCollapsingTitle: the title waits until the list's PageTitle has scrolled under the bar. */
  titleOpacity?: Animated.AnimatedInterpolation<number>
  dividerOpacity?: Animated.AnimatedInterpolation<number>
}

// The one top bar: leading button, a centred compact title, and up to two trailing buttons.
export function NavBar({
  leading,
  title,
  subtitle,
  center,
  trailing,
  accessory,
  style,
  titleOpacity,
  dividerOpacity
}: NavBarProps) {
  useMobileColorScheme()
  return (
    <View style={[styles.chrome, dividerOpacity && styles.chromeWithoutDivider, style]}>
      <View style={styles.bar}>
        <View style={styles.side}>{leading}</View>
        <Animated.View style={[styles.center, titleOpacity && { opacity: titleOpacity }]}>
          {center ?? (
            <>
              {title !== undefined ? (
                <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                  {title}
                </Text>
              ) : null}
              {subtitle !== undefined ? (
                typeof subtitle === 'string' ? (
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {subtitle}
                  </Text>
                ) : (
                  <View style={styles.subtitleRow}>{subtitle}</View>
                )
              ) : null}
            </>
          )}
        </Animated.View>
        <View style={[styles.side, styles.trailing]}>{trailing}</View>
      </View>
      {accessory !== undefined && accessory !== null ? (
        <View style={styles.accessory}>{accessory}</View>
      ) : null}
      {dividerOpacity ? (
        <Animated.View pointerEvents="none" style={[styles.divider, { opacity: dividerOpacity }]} />
      ) : null}
    </View>
  )
}

/** Subtitle text for a custom subtitle row, e.g. beside a connection dot. */
export function NavBarSubtitleText({ children }: { children: ReactNode }) {
  useMobileColorScheme()
  return (
    <Text style={styles.subtitle} numberOfLines={1}>
      {children}
    </Text>
  )
}

const styles = themedStyleSheet(() => ({
  chrome: {
    backgroundColor: colors.bgBase,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  bar: {
    height: NAV_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md
  },
  accessory: {
    paddingBottom: spacing.sm
  },
  chromeWithoutDivider: {
    borderBottomColor: 'transparent'
  },
  divider: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -StyleSheet.hairlineWidth,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  },
  // Equal sides keep the title centred whatever the buttons on either side.
  side: {
    flex: 1,
    flexBasis: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  trailing: {
    justifyContent: 'flex-end'
  },
  center: {
    flexShrink: 1,
    maxWidth: '62%',
    alignItems: 'center'
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600'
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 1
  }
}))
