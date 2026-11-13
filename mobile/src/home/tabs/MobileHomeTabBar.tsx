import {
  Bot,
  CalendarClock,
  Gauge,
  LayoutList,
  Settings,
  type LucideIcon
} from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming
} from 'react-native-reanimated'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { HOME_EASE_OUT, type HomeTabId } from './home-tabs'

const TAB_ICONS: Record<HomeTabId, LucideIcon> = {
  feed: LayoutList,
  agents: Bot,
  usage: Gauge,
  automations: CalendarClock,
  settings: Settings
}

export const HOME_TAB_BAR_HEIGHT = 52

export function MobileHomeTabBar(props: {
  tabs: readonly HomeTabId[]
  active: HomeTabId
  bottomInset: number
  /** Agents that need you; shown on Agents. */
  agentsBadge: number
  onSelect: (tab: HomeTabId) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const labels: Record<HomeTabId, string> = {
    feed: t('home.tabs.feed', 'Feed'),
    agents: t('home.tabs.agents', 'Agents'),
    usage: t('home.tabs.usage', 'Usage'),
    automations: t('home.tabs.automations', 'Automations'),
    settings: t('common.settings', 'Settings')
  }
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(props.bottomInset, spacing.sm) }]}
      // Android has no 'tabbar' role and crashes on mount; iOS keeps its tab-bar trait.
      accessibilityRole={Platform.OS === 'ios' ? 'tabbar' : 'tablist'}
    >
      {props.tabs.map((tab) => (
        <TabButton
          key={tab}
          icon={TAB_ICONS[tab]}
          label={labels[tab]}
          selected={tab === props.active}
          badge={tab === 'agents' ? props.agentsBadge : 0}
          onPress={() => props.onSelect(tab)}
        />
      ))}
    </View>
  )
}

function TabButton(props: {
  icon: LucideIcon
  label: string
  selected: boolean
  badge: number
  onPress: () => void
}) {
  useMobileColorScheme()
  const [pressed, setPressed] = useState(false)
  const Icon = props.icon
  const tint = props.selected ? colors.textPrimary : colors.textMuted
  return (
    <Pressable
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityLabel={props.badge > 0 ? `${props.label}, ${props.badge}` : props.label}
      accessibilityState={{ selected: props.selected }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={props.onPress}
    >
      {/* Press feedback on the glyph only, so the label never jitters. */}
      <Animated.View
        style={[
          styles.icon,
          {
            transform: [{ scale: pressed ? 0.88 : 1 }],
            transitionProperty: 'transform',
            transitionDuration: pressed ? 90 : 160,
            transitionTimingFunction: 'ease-out'
          }
        ]}
      >
        <Icon size={25} strokeWidth={props.selected ? 2.2 : 1.8} color={tint} />
        {props.badge > 0 ? <TabBadge count={props.badge} /> : null}
      </Animated.View>
      <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/** Pops in when it first appears, and nudges when the count changes so a new ask is noticed. */
function TabBadge({ count }: { count: number }) {
  useMobileColorScheme()
  const reducedMotion = useReducedMotionEnabled() === true
  const scale = useSharedValue(reducedMotion ? 1 : 0.6)
  const opacity = useSharedValue(reducedMotion ? 1 : 0)

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    opacity.value = withTiming(1, { duration: 140, easing: HOME_EASE_OUT })
    scale.value = withSequence(
      withTiming(1.18, { duration: 140, easing: HOME_EASE_OUT }),
      withTiming(1, { duration: 160, easing: HOME_EASE_OUT })
    )
  }, [count, opacity, reducedMotion, scale])

  const style = useAnimatedStyle(
    () => ({ opacity: opacity.value, transform: [{ scale: scale.value }] }),
    [opacity, scale]
  )
  return (
    <Animated.View style={[styles.badge, style]} pointerEvents="none">
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </Animated.View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    flexDirection: 'row',
    paddingTop: 6,
    paddingHorizontal: spacing.xs,
    backgroundColor: colors.bgBase,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  tab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    gap: 3,
    paddingTop: 2
  },
  icon: { width: 30, height: 26, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 10.5, fontWeight: '500', letterSpacing: 0.1 },
  badge: {
    position: 'absolute',
    top: -4,
    left: 20,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.statusAmber,
    borderWidth: 1.5,
    borderColor: colors.bgBase
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#000' }
}))
