import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Plus } from 'lucide-react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from 'react-native-reanimated'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useDrawerReducedMotion } from '../../components/bottom-drawer/bottom-drawer-constants'
import { SETTLE_SPRING } from '../../components/motion/sheet-motion-values'
import { NavBarBadge } from '../../components/nav-bar/NavBarButton'
import { useKeyboardPersistingTaps } from '../../platform/keyboard/keyboard-persisting-taps'
import { useBackEdgeGuard } from '../../navigation/use-back-edge-guard'
import { useNow } from '../../hooks/use-now'
import { agentStateLabel } from '../../worktree/agent-lineage/agent-row-display'
import { colors, feedback, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import {
  buildMobileSessionTabSummary,
  countMobileSessionDesktopTabs,
  isForkedChatTab,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'
import { MobileSessionTabBarLayer, tabBarLayerStyles } from './MobileSessionTabBarLayer'
import { MobileSessionTabsSheet } from './MobileSessionTabsSheet'
import { useMobileSessionTabStopConfirm } from './MobileSessionTabStopConfirm'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import type { MobileSessionController } from '../use-mobile-session-controller'

// A drag that ends faster than this toward a tab moves there, however short it was.
const FLICK_VELOCITY = 600
// With no tab on that side, the tab gives only this share of the drag.
const EDGE_RESISTANCE = 0.25
// A tab a full width out of the middle is drawn this faint, so the arriving one brightens as it comes.
const SIDE_OPACITY = 0.4
const DRAG_CLICK_WINDOW_MS = 400

/** The tab you're in as one cell: tap for its actions, swipe for the next one; the count shows every tab, + adds one. */
export function MobileSessionTabBar({
  controller,
  inTopBar,
  actionsCollapsed = false,
  homeChatId = null
}: {
  controller: MobileSessionController
  inTopBar: boolean
  actionsCollapsed?: boolean
  /** The route bot's main chat, whose recorded name "Home" reads in the phone's language. */
  homeChatId?: string | null
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    activeSessionTabId,
    connState,
    createTabBusy,
    handleOpenNewTab,
    switchSessionTab,
    openSessionTabActionSheetAfterKeyboardDismiss,
    handleCloseSessionTab,
    visibleTabs,
    terminals
  } = controller
  // Why: the first tap must reach the bar with the keyboard open instead of only dismissing it (#5106).
  const keepsKeyboard = useKeyboardPersistingTaps('handled')
  const now = useNow(60_000)
  const rows = useMemo(
    () =>
      visibleTabs.map((tab) => {
        const built = buildMobileSessionTabSummary(tab, terminals, now)
        const summary =
          homeChatId !== null &&
          tab.type === 'agent-session' &&
          tab.sessionId === homeChatId &&
          built.title === 'Home'
            ? { ...built, title: t('bots.tabs.homeTitle', 'Home') }
            : built
        // The tab on screen is being read (useMarkViewedAgentRead), so it never rings.
        return summary.unread && tab.id === activeSessionTabId
          ? { ...summary, unread: false }
          : summary
      }),
    [visibleTabs, terminals, now, activeSessionTabId, homeChatId, t]
  )
  const activeIndex = rows.findIndex((row) => row.tab.id === activeSessionTabId)
  const active: MobileSessionTabSummary | undefined = rows[activeIndex]
  const previous = activeIndex > 0 ? rows[activeIndex - 1] : undefined
  const next = activeIndex !== -1 ? rows[activeIndex + 1] : undefined
  const needYou = countMobileSessionDesktopTabs(
    rows.filter((row) => row.tab.id !== activeSessionTabId && row.group === 'needs-you')
  )
  const [sheetOpen, setSheetOpen] = useState(false)
  // A swipe from the screen's edge on the tab steps tabs; Back keeps the rest of the edge.
  // An edge swipe moves right, to the previous tab; with none (or sideways, beside Back's chevron) the edge stays Back's.
  const edgeGuard = useBackEdgeGuard(previous !== undefined && !inTopBar)
  const [dragging, setDragging] = useState(false)
  const stopConfirm = useMobileSessionTabStopConfirm(handleCloseSessionTab)

  const reducedMotion = useDrawerReducedMotion()
  const offset = useSharedValue(0)
  const width = useSharedValue(0)
  // A committed swipe, waiting for its tab to open before the track re-bases under it.
  const arrivingRef = useRef<{ tabId: string; shift: number; velocity: number } | null>(null)
  // On the web, releasing a mouse drag also clicks the tab.
  const dragEndedAtRef = useRef(0)
  const settle = (velocity: number) =>
    reducedMotion
      ? withTiming(0, { duration: 0, reduceMotion: ReduceMotion.Never })
      : withSpring(0, { ...SETTLE_SPRING, velocity })
  // The arriving tab is open now: draw it where its peek was, then let it settle at the finger's speed.
  useLayoutEffect(() => {
    const arriving = arrivingRef.current
    arrivingRef.current = null
    if (arriving && arriving.tabId === activeSessionTabId) {
      offset.value = offset.value + arriving.shift
      offset.value = settle(arriving.velocity)
      return
    }
    offset.value = 0
  }, [activeSessionTabId])
  // `direction` 1 steps to the previous tab (a rightward swipe), -1 to the next one.
  const step = (target: MobileSessionTabSummary | undefined, direction: 1 | -1, velocity = 0) => {
    if (!target) {
      offset.value = settle(velocity)
      return
    }
    arrivingRef.current = { tabId: target.tab.id, shift: -direction * width.value, velocity }
    // switchSessionTab plays the switch's one haptic.
    switchSessionTab(target.tab)
  }
  // Callbacks run on JS: the session page is a web document, and stepping switches React state.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(rows.length > 1)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    // A drag isn't a tap, so the cell drops its pressed fill once the tab starts to move.
    .onStart(() => setDragging(true))
    .onFinalize(() => setDragging(false))
    .onUpdate((event) => {
      const target = event.translationX > 0 ? previous : next
      offset.value = target ? event.translationX : event.translationX * EDGE_RESISTANCE
    })
    .onEnd((event, success) => {
      // oxlint-disable-next-line react/purity -- runs when the drag ends, never during render.
      dragEndedAtRef.current = Date.now()
      // An interrupted drag (touch cancelled, another gesture took over) never switches tabs.
      if (!success) {
        offset.value = settle(0)
        return
      }
      const direction = event.translationX > 0 ? 1 : -1
      const flicked =
        Math.abs(event.velocityX) > FLICK_VELOCITY && Math.sign(event.velocityX) === direction
      if (Math.abs(event.translationX) > width.value / 2 || flicked) {
        step(direction === 1 ? previous : next, direction, event.velocityX)
        return
      }
      // Past the last tab the drag moved at a quarter speed, so the release does too.
      const target = direction === 1 ? previous : next
      offset.value = settle(target ? event.velocityX : event.velocityX * EDGE_RESISTANCE)
    })
  // Each layer sits a width from its neighbour and fades with its distance from the middle.
  const layerStyle = (place: -1 | 0 | 1) => () => {
    const x = offset.value + place * width.value
    const away = Math.min(Math.abs(x) / Math.max(width.value, 1), 1)
    return { transform: [{ translateX: x }], opacity: 1 - away * (1 - SIDE_OPACITY) }
  }
  // Web has no worklet plugin; mapper hooks need this explicit dependency list.
  const previousStyle = useAnimatedStyle(layerStyle(-1), [offset, width])
  const currentStyle = useAnimatedStyle(layerStyle(0), [offset, width])
  const nextStyle = useAnimatedStyle(layerStyle(1), [offset, width])

  const status = active?.dotState && active.dotState !== 'idle' ? active.dotState : undefined
  const tabCount = countMobileSessionDesktopTabs(rows)
  const countLabel =
    tabCount === 1
      ? t('session.tabBar.oneTab', '1 tab')
      : t('session.tabBar.tabCount', '{{count}} tabs', { count: tabCount })
  const tabLabel = [
    active && isForkedChatTab(active.tab) ? mobileForkAccessibleName(active.title) : active?.title,
    status ? agentStateLabel(status) : null
  ]
    .filter(Boolean)
    .join(', ')
  const needYouLabel =
    needYou === 1
      ? t('session.tabBar.needYou_one', '{{count}} needs you', { count: needYou })
      : t('session.tabBar.needYou_other', '{{count}} need you', { count: needYou })
  const countAccessibilityLabel = needYou > 0 ? `${countLabel}, ${needYouLabel}` : countLabel
  const createDisabled = createTabBusy || connState !== 'connected'
  const openTabActions = () => {
    // The click a drag release produces on the web belongs to the drag.
    if (!active || Date.now() - dragEndedAtRef.current < DRAG_CLICK_WINDOW_MS) {
      return
    }
    openSessionTabActionSheetAfterKeyboardDismiss(active.tab)
  }

  return (
    <View ref={keepsKeyboard} style={inTopBar ? styles.barInTopBar : styles.bar}>
      {rows.length === 0 ? (
        <View style={[styles.tabCell, styles.emptyCell]}>
          <Text style={styles.emptyTitle} numberOfLines={1}>
            {t('session.tabBar.noTabs', 'No tabs')}
          </Text>
        </View>
      ) : (
        <>
          {/* pan-y keeps vertical touches with the page on the web. */}
          <GestureDetector gesture={pan} touchAction="pan-y">
            <View
              ref={edgeGuard.ref}
              style={styles.tabCell}
              // Neighbours sit a whole cell aside, so none shows at rest and each arrives at the same inset.
              onLayout={(event) => {
                width.value = event.nativeEvent.layout.width
                edgeGuard.onLayout()
              }}
            >
              <Pressable
                style={({ pressed }) => [
                  styles.tabPress,
                  pressed && !dragging && styles.cellPressed
                ]}
                onPress={openTabActions}
                disabled={!active}
                accessibilityRole="button"
                accessibilityLabel={tabLabel || countLabel}
                accessibilityHint={t('session.tabBar.actionsHint', 'Shows actions for this tab')}
                accessibilityActions={[
                  ...(next
                    ? [{ name: 'nextTab', label: t('session.tabBar.next', 'Next tab') }]
                    : []),
                  ...(previous
                    ? [{ name: 'previousTab', label: t('session.tabBar.previous', 'Previous tab') }]
                    : [])
                ]}
                onAccessibilityAction={(event) => {
                  const name = event.nativeEvent.actionName
                  if (name === 'nextTab') {
                    step(next, -1)
                  } else if (name === 'previousTab') {
                    step(previous, 1)
                  }
                }}
              >
                {/* Only the contents slide, so the cell stays flush with the screen edge. */}
                <View style={styles.track}>
                  {previous ? (
                    <Animated.View
                      style={[tabBarLayerStyles.tabContent, styles.sideLayer, previousStyle]}
                      importantForAccessibility="no-hide-descendants"
                    >
                      <MobileSessionTabBarLayer row={previous} live={false} />
                    </Animated.View>
                  ) : null}
                  <Animated.View style={[tabBarLayerStyles.tabContent, currentStyle]}>
                    {active ? (
                      <MobileSessionTabBarLayer row={active} live />
                    ) : (
                      <Text style={tabBarLayerStyles.title} numberOfLines={1}>
                        {countLabel}
                      </Text>
                    )}
                  </Animated.View>
                  {next ? (
                    <Animated.View
                      style={[tabBarLayerStyles.tabContent, styles.sideLayer, nextStyle]}
                      importantForAccessibility="no-hide-descendants"
                    >
                      <MobileSessionTabBarLayer row={next} live={false} />
                    </Animated.View>
                  ) : null}
                </View>
              </Pressable>
            </View>
          </GestureDetector>
          <Pressable
            style={({ pressed }) => [
              styles.sideCell,
              actionsCollapsed && !inTopBar && styles.lastCell,
              pressed && styles.cellPressed
            ]}
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={countAccessibilityLabel}
            accessibilityHint={t('session.tabBar.hint', 'Shows all tabs')}
          >
            <View style={styles.countBox}>
              <Text style={styles.countText}>{tabCount}</Text>
              <NavBarBadge
                count={needYou}
                color={colors.agentQuestion}
                ringColor={colors.bgPanel}
                style={styles.countBadge}
              />
            </View>
          </Pressable>
        </>
      )}
      {/* A collapsed bar's + lives in the header's ⋯ menu. */}
      {!actionsCollapsed ? (
        <Pressable
          style={({ pressed }) => [
            styles.sideCell,
            !inTopBar && styles.lastCell,
            pressed && styles.cellPressed,
            createDisabled && styles.cellDisabled
          ]}
          disabled={createDisabled}
          onPress={handleOpenNewTab}
          accessibilityRole="button"
          accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
          accessibilityState={{ disabled: createDisabled }}
        >
          <Plus size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      ) : null}
      <MobileSessionTabsSheet
        controller={controller}
        tabs={rows}
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onStopTabs={stopConfirm.ask}
      />
      {stopConfirm.confirm}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  // Cancels the top bar's vertical padding so the cells run the bar's full height.
  barInTopBar: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    alignSelf: 'stretch',
    marginVertical: -spacing.xs,
    marginLeft: spacing.md,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  // The open tab, drawn like the strip's active tab: raised, with a line under it.
  tabCell: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.bgRaised,
    borderBottomWidth: 2,
    borderBottomColor: colors.textSecondary,
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  tabPress: {
    flex: 1,
    justifyContent: 'center',
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm
  },
  track: { flex: 1, justifyContent: 'center' },
  // Neighbours lie over the open tab's row; their transform moves them a width aside.
  sideLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  // With no tab to raise, the cell sits flat in the bar like the side cells.
  emptyCell: {
    backgroundColor: 'transparent',
    borderBottomColor: 'transparent',
    justifyContent: 'center',
    paddingLeft: spacing.lg
  },
  emptyTitle: { fontSize: 14, color: colors.textMuted },
  sideCell: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  // At the screen edge; in the top bar the hairline stays to part the cells from the round buttons.
  lastCell: { borderRightWidth: 0 },
  cellPressed: { backgroundColor: colors.translucentFill },
  cellDisabled: { opacity: feedback.disabledOpacity },
  countBox: {
    minWidth: 19,
    height: 19,
    paddingHorizontal: 3,
    borderRadius: 6,
    borderWidth: 1.8,
    borderColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  // How many other tabs need you, on the count's corner.
  countBadge: { position: 'absolute', top: -8, right: -10 }
}))

// The group room's thread bar draws its cells with these too.
export { styles as sessionTabBarStyles }
