import { useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, Plus } from 'lucide-react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming
} from 'react-native-reanimated'
import { triggerMediumImpact, triggerSelection } from '../../platform/haptics'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { AgentStateDot } from '../../components/AgentStateDot'
import { ArrivalFade } from '../../components/ArrivalFade'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { useDrawerReducedMotion } from '../../components/bottom-drawer/bottom-drawer-constants'
import { SHEET_CURVE } from '../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { useKeyboardPersistingTaps } from '../../platform/keyboard-persisting-taps'
import { useNow } from '../../hooks/use-now'
import { agentStateLabel, type AgentDotState } from '../../worktree/agent-row-display'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { buildMobileSessionTabRow, type MobileSessionTabRow } from './mobile-session-tab-rows'
import { MobileSessionTabMark } from './MobileSessionTabMark'
import { MobileSessionTabsSheet } from './MobileSessionTabsSheet'
import type { MobileSessionController } from '../use-mobile-session-controller'

const PILL_HEIGHT = 34
const SWIPE_SETTLE_MS = 250
// A tab arriving from the side starts this far out, as a share of the pill's width.
const SWIPE_ENTRY_SHARE = 0.4
const FLICK_VELOCITY = 600
// With no tab on that side, the pill gives only this share of the drag.
const EDGE_RESISTANCE = 0.25
const DRAG_CLICK_WINDOW_MS = 400

// A tab drawn before it had any agent state (from the phone's store) fades its dot in when one lands.
function TabPillDot({ tabId, state }: { tabId: string; state: AgentDotState | undefined }) {
  const [startedEmpty] = useState({ tabId, empty: state === undefined })
  if (startedEmpty.tabId === tabId && startedEmpty.empty) {
    return <ArrivingTabPillDot state={state} />
  }
  return state && state !== 'idle' ? <AgentStateDot state={state} /> : null
}

// Mounted with the bare tab, so the motion preference is read before the dot arrives.
function ArrivingTabPillDot({ state }: { state: AgentDotState | undefined }) {
  const reducedMotion = useReducedMotionEnabled()
  if (!state || state === 'idle') {
    return null
  }
  return (
    <ArrivalFade animate={reducedMotion === false}>
      <AgentStateDot state={state} />
    </ArrivalFade>
  )
}

/** The tab you're in as one pill: tap for every tab, swipe for the next one, + for a new one. */
export function MobileSessionTabPill({
  controller,
  inTopBar,
  actionsCollapsed = false
}: {
  controller: MobileSessionController
  inTopBar: boolean
  actionsCollapsed?: boolean
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
    visibleTabs,
    terminals
  } = controller
  // Why: the first tap must reach the pill with the keyboard open instead of only dismissing it (#5106).
  const keepsKeyboard = useKeyboardPersistingTaps('handled')
  const now = useNow(60_000)
  const rows = useMemo(
    () => visibleTabs.map((tab) => buildMobileSessionTabRow(tab, terminals, now)),
    [visibleTabs, terminals, now]
  )
  const activeIndex = rows.findIndex((row) => row.tab.id === activeSessionTabId)
  const active: MobileSessionTabRow | undefined = rows[activeIndex]
  const previous = activeIndex > 0 ? rows[activeIndex - 1] : undefined
  const next = activeIndex !== -1 ? rows[activeIndex + 1] : undefined
  const othersNeedYou = rows.some(
    (row) => row.tab.id !== activeSessionTabId && row.group === 'needs-you'
  )
  const [sheetOpen, setSheetOpen] = useState(false)

  const reducedMotion = useDrawerReducedMotion()
  const offset = useSharedValue(0)
  const width = useSharedValue(0)
  // On the web, releasing a mouse drag also clicks the pill.
  const dragEndedAtRef = useRef(0)
  const settle = (to: number) =>
    withTiming(
      to,
      reducedMotion
        ? { duration: 0, reduceMotion: ReduceMotion.Never }
        : { duration: SWIPE_SETTLE_MS, easing: Easing.bezier(...SHEET_CURVE) }
    )
  const step = (target: MobileSessionTabRow | undefined, direction: 1 | -1) => {
    if (!target) {
      offset.value = settle(0)
      return
    }
    triggerSelection()
    switchSessionTab(target.tab)
    offset.value = withSequence(
      withTiming(-direction * width.value * SWIPE_ENTRY_SHARE, { duration: 0 }),
      settle(0)
    )
  }
  // Callbacks run on JS: the session page is a web document, and stepping switches React state.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(rows.length > 1)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((event) => {
      const target = event.translationX > 0 ? previous : next
      offset.value = target ? event.translationX : event.translationX * EDGE_RESISTANCE
    })
    .onEnd((event) => {
      // oxlint-disable-next-line react/purity -- runs when the drag ends, never during render.
      dragEndedAtRef.current = Date.now()
      const direction = event.translationX > 0 ? 1 : -1
      const flicked =
        Math.abs(event.velocityX) > FLICK_VELOCITY && Math.sign(event.velocityX) === direction
      if (Math.abs(event.translationX) > width.value / 2 || flicked) {
        step(direction === 1 ? previous : next, direction)
        return
      }
      offset.value = settle(0)
    })
  // Web has no worklet plugin; mapper hooks need this explicit dependency list.
  const pillStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: offset.value }],
      opacity: 1 - Math.min(Math.abs(offset.value) / Math.max(width.value, 1), 1) * 0.6
    }),
    [offset, width]
  )

  const status = active?.dotState && active.dotState !== 'idle' ? active.dotState : undefined
  const countLabel =
    rows.length === 1
      ? t('session.tabPill.oneTab', '1 tab')
      : t('session.tabPill.tabCount', '{{count}} tabs', { count: rows.length })
  const accessibilityLabel = [
    active?.title,
    status ? agentStateLabel(status) : null,
    countLabel,
    othersNeedYou ? t('session.tabPill.anotherNeedsYou', 'another tab needs you') : null
  ]
    .filter(Boolean)
    .join(', ')
  const openSheet = () => {
    if (Date.now() - dragEndedAtRef.current < DRAG_CLICK_WINDOW_MS) {
      return
    }
    setSheetOpen(true)
  }

  return (
    <View ref={keepsKeyboard} style={inTopBar ? styles.barInTopBar : styles.bar}>
      <View
        style={styles.track}
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width
        }}
      >
        {/* pan-y keeps vertical touches with the page on the web. */}
        <GestureDetector gesture={pan} touchAction="pan-y">
          <Animated.View style={[styles.pillFrame, pillStyle]}>
            <Pressable
              style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
              onPress={openSheet}
              onLongPress={() => {
                if (!active) {
                  return
                }
                triggerMediumImpact()
                openSessionTabActionSheetAfterKeyboardDismiss(active.tab)
              }}
              delayLongPress={400}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              accessibilityHint={t('session.tabPill.hint', 'Shows all tabs')}
              accessibilityActions={[
                { name: 'longpress', label: t('session.tabPill.tabActions', 'Tab actions') },
                ...(next
                  ? [{ name: 'nextTab', label: t('session.tabPill.next', 'Next tab') }]
                  : []),
                ...(previous
                  ? [{ name: 'previousTab', label: t('session.tabPill.previous', 'Previous tab') }]
                  : [])
              ]}
              onAccessibilityAction={(event) => {
                const name = event.nativeEvent.actionName
                if (name === 'longpress' && active) {
                  openSessionTabActionSheetAfterKeyboardDismiss(active.tab)
                } else if (name === 'nextTab') {
                  step(next, -1)
                } else if (name === 'previousTab') {
                  step(previous, 1)
                }
              }}
            >
              {active ? (
                <>
                  <TabPillDot tabId={active.tab.id} state={active.dotState} />
                  <View style={styles.mark}>
                    <MobileSessionTabMark row={active} size={15} />
                  </View>
                </>
              ) : null}
              <Text style={styles.title} numberOfLines={1}>
                {active?.title ?? countLabel}
              </Text>
              <View style={styles.count}>
                <View style={styles.countBox}>
                  <Text style={styles.countText}>{rows.length}</Text>
                </View>
                {othersNeedYou ? <View style={styles.alert} /> : null}
                <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.4} />
              </View>
            </Pressable>
          </Animated.View>
        </GestureDetector>
      </View>
      {/* Terminal layout and Quick commands live in the header's ⋯ menu. */}
      {!actionsCollapsed ? (
        <NavBarButton
          disabled={createTabBusy || connState !== 'connected'}
          onPress={handleOpenNewTab}
          accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
          icon={Plus}
        />
      ) : null}
      <MobileSessionTabsSheet
        controller={controller}
        rows={rows}
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // The right inset matches the nav bar's, so the + lines up with the ⋯ above it.
  bar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  barInTopBar: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginLeft: spacing.sm
  },
  track: { flex: 1, minWidth: 0 },
  pillFrame: { width: '100%' },
  pill: {
    height: PILL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingLeft: 11,
    paddingRight: spacing.sm,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  pillPressed: { backgroundColor: colors.translucentFill },
  // Keeps web SVGs from shrinking before the title ellipsizes.
  mark: { flexShrink: 0 },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 },
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
  // Another tab needs you: a red dot on the count's corner, ringed in the pill's colour.
  alert: {
    position: 'absolute',
    top: -4,
    left: 13,
    width: 9,
    height: 9,
    borderRadius: radii.pill,
    backgroundColor: colors.statusRed,
    borderWidth: 2,
    borderColor: colors.bgRaised
  }
}))
