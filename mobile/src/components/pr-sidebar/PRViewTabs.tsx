import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { triggerSelection } from '../../platform/haptics'

export type PRViewTab = 'overview' | 'files' | 'comments' | 'checks'

export type PRViewTabItem = {
  value: PRViewTab
  label: string
  /** Omitted while the host has not reported the list. */
  count?: number
  /** Tints the count, e.g. failing checks. */
  alert?: boolean
}

/** The PR page's tab strip, underlined like desktop's PR page tabs. */
export function PRViewTabs({
  tabs,
  active,
  onSelect
}: {
  tabs: readonly PRViewTabItem[]
  active: PRViewTab
  onSelect: (tab: PRViewTab) => void
}) {
  useMobileColorScheme()
  return (
    // Tabs shrink rather than scroll: a sideways scroll would fight the review drawer's swipe-to-close.
    <View style={styles.bar} accessibilityRole="tablist">
      {tabs.map((tab) => {
        const selected = tab.value === active
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            testID={`pr-view-tab-${tab.value}`}
            onPress={() => {
              if (!selected) {
                triggerSelection()
                onSelect(tab.value)
              }
            }}
            style={[styles.tab, selected && styles.tabSelected]}
          >
            <Text style={[styles.label, selected && styles.labelSelected]} numberOfLines={1}>
              {tab.label}
            </Text>
            {tab.count !== undefined && tab.count > 0 ? (
              <Text style={[styles.count, tab.alert && styles.countAlert]}>{tab.count}</Text>
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  tab: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabSelected: { borderBottomColor: colors.textPrimary },
  label: {
    flexShrink: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textSecondary
  },
  labelSelected: { color: colors.textPrimary, fontWeight: '600' },
  count: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.pill,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 1,
    fontVariant: ['tabular-nums']
  },
  countAlert: { color: colors.statusRed }
}))
