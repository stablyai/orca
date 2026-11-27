import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View, type ScrollViewInstance } from 'react-native'
import { Bell, Plus } from 'lucide-react-native'
import { triggerMediumImpact } from '../../platform/haptics/haptics'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { ArrivalFade } from '../../components/motion/ArrivalFade'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { useNow } from '../../hooks/use-now'
import { agentStateLabel, type AgentDotState } from '../../worktree/agent-lineage/agent-row-display'
import {
  resolveTabStripEdgeHint,
  resolveTabStripHiddenTabs,
  resolveTabStripScrollOffset,
  resolveTabStripTapOffset,
  type TabStripEdgeHint,
  type TabStripHiddenTabs
} from '../../components/controls/tab-strip-scroll'
import { colors } from '../../theme/mobile-theme'
import { mobileSessionTabStripStyles as styles } from './mobile-session-tab-strip-styles'
import { useKeyboardPersistingTaps } from '../../platform/keyboard/keyboard-persisting-taps'
import { buildMobileSessionTabSummary, isForkedChatTab } from './mobile-session-tab-rows'
import { MobileSessionTabCountButton } from './MobileSessionTabCountButton'
import { MobileSessionTabMark } from './MobileSessionTabMark'
import { MobileSessionTabsSheet } from './MobileSessionTabsSheet'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import type { MobileSessionController } from '../use-mobile-session-controller'

const DOUBLE_TAP_RENAME_MS = 300

function StripTabDot({
  tabId,
  state,
  unreadBell
}: {
  tabId: string
  state: AgentDotState | undefined
  unreadBell: boolean
}) {
  const [startedEmpty] = useState({ tabId, empty: state === undefined && !unreadBell })
  if (unreadBell) {
    return <Bell size={10} color={colors.statusAmber} fill={colors.statusAmber} />
  }
  if (startedEmpty.tabId === tabId && startedEmpty.empty) {
    return <ArrivingStripTabDot state={state} />
  }
  return state && state !== 'idle' ? <AgentStateDot state={state} /> : null
}

function TabStripEdgeBadge({ hint }: { hint: TabStripEdgeHint }) {
  return hint === 'unread' ? (
    <Bell size={10} color={colors.statusAmber} fill={colors.statusAmber} />
  ) : (
    <AgentStateDot state={hint} />
  )
}

function ArrivingStripTabDot({ state }: { state: AgentDotState | undefined }) {
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

/** Narrow horizontally scrollable tab strip paired with the `[N]` switcher sheet and New Tab cell. */
export function MobileSessionTabStrip({
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
    showRecentSessionCards,
    setShowRecentSessionCards,
    switchSessionTab,
    openSessionTabActionSheetAfterKeyboardDismiss,
    setRenameTarget,
    visibleTabs,
    terminals
  } = controller

  const keepsKeyboard = useKeyboardPersistingTaps('handled')
  const scrollRef = useRef<ScrollViewInstance>(null)
  const offsetRef = useRef(0)
  const viewportWidthRef = useRef(0)
  const contentWidthRef = useRef(0)
  const tabLayoutsRef = useRef(new Map<string, { x: number; width: number }>())
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTabTapRef = useRef<{ id: string; at: number } | null>(null)
  const activeTabIdRef = useRef(activeSessionTabId)
  activeTabIdRef.current = activeSessionTabId

  const now = useNow(60_000)
  const rows = useMemo(
    () =>
      visibleTabs.map((tab) => {
        const summary = buildMobileSessionTabSummary(tab, terminals, now)
        return summary.unread && tab.id === activeSessionTabId
          ? { ...summary, unread: false }
          : summary
      }),
    [visibleTabs, terminals, now, activeSessionTabId]
  )
  const tabStates = useMemo(() => {
    const states = new Map<string, TabStripEdgeHint>()
    for (const row of rows) {
      if (row.unread && row.group === 'other') {
        states.set(row.tab.id, 'unread')
      } else if (row.dotState) {
        states.set(row.tab.id, row.dotState)
      }
    }
    return states
  }, [rows])

  const [hiddenTabs, setHiddenTabs] = useState<TabStripHiddenTabs>({ left: [], right: [] })
  const refreshHiddenTabs = useCallback(() => {
    const next = resolveTabStripHiddenTabs({
      layouts: tabLayoutsRef.current,
      viewportWidth: viewportWidthRef.current,
      currentOffset: offsetRef.current
    })
    setHiddenTabs((prev) =>
      prev.left.join('\n') === next.left.join('\n') &&
      prev.right.join('\n') === next.right.join('\n')
        ? prev
        : next
    )
  }, [])

  const scrollActiveTabIntoView = useCallback((tabId: string | null, animated: boolean) => {
    if (!tabId || holdTimerRef.current !== null) {
      return
    }
    const layout = tabLayoutsRef.current.get(tabId)
    if (!layout) {
      return
    }
    const nextOffset = resolveTabStripScrollOffset({
      tabX: layout.x,
      tabWidth: layout.width,
      viewportWidth: viewportWidthRef.current,
      contentWidth: contentWidthRef.current,
      currentOffset: offsetRef.current
    })
    if (Math.abs(nextOffset - offsetRef.current) > 0.5) {
      offsetRef.current = nextOffset
      scrollRef.current?.scrollTo({ x: nextOffset, animated })
    }
  }, [])

  const cancelHeldReveal = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }, [])

  const holdReveal = useCallback(
    (targetOffset: number, durationMs: number) => {
      cancelHeldReveal()
      offsetRef.current = targetOffset
      scrollRef.current?.scrollTo({ x: targetOffset, animated: true })
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null
        scrollActiveTabIntoView(activeTabIdRef.current, true)
      }, durationMs)
    },
    [cancelHeldReveal, scrollActiveTabIntoView]
  )

  useEffect(() => cancelHeldReveal, [cancelHeldReveal])
  useEffect(() => {
    scrollActiveTabIntoView(activeSessionTabId, true)
  }, [activeSessionTabId, scrollActiveTabIntoView])

  const leftHint = resolveTabStripEdgeHint(hiddenTabs.left, tabStates)
  const rightHint = resolveTabStripEdgeHint(hiddenTabs.right, tabStates)

  const pressTab = useCallback(
    (tab: (typeof visibleTabs)[number]) => {
      const at = Date.now()
      const lastTap = lastTabTapRef.current
      lastTabTapRef.current = { id: tab.id, at }
      if (
        lastTap?.id === tab.id &&
        at - lastTap.at < DOUBLE_TAP_RENAME_MS &&
        tab.type === 'terminal' &&
        typeof tab.terminal === 'string'
      ) {
        const terminal = terminals.find((item) => item.handle === tab.terminal)
        if (terminal) {
          lastTabTapRef.current = null
          triggerMediumImpact()
          setRenameTarget(terminal)
          return
        }
      }
      cancelHeldReveal()
      const nextOffset = resolveTabStripTapOffset({
        tabId: tab.id,
        tabs: visibleTabs,
        layouts: tabLayoutsRef.current,
        viewportWidth: viewportWidthRef.current,
        contentWidth: contentWidthRef.current,
        currentOffset: offsetRef.current
      })
      if (nextOffset !== offsetRef.current) {
        holdReveal(nextOffset, DOUBLE_TAP_RENAME_MS)
      }
      switchSessionTab(tab)
    },
    [cancelHeldReveal, holdReveal, setRenameTarget, switchSessionTab, terminals, visibleTabs]
  )

  const attachTabStrip = useCallback((view: ScrollViewInstance | null) => {
    if (view) {
      offsetRef.current = 0
      viewportWidthRef.current = 0
      contentWidthRef.current = 0
      tabLayoutsRef.current.clear()
    }
    scrollRef.current = view
  }, [])

  const createDisabled = createTabBusy || connState !== 'connected'
  const anyUnread = rows.some((row) => row.unread)
  const othersNeedYou = rows.some(
    (row) => row.tab.id !== activeSessionTabId && row.group === 'needs-you'
  )
  const showNewTab = !actionsCollapsed

  return (
    <View ref={keepsKeyboard} style={inTopBar ? styles.barInTopBar : styles.bar}>
      {/* Why: tab taps must register on first press with the keyboard open instead of being eaten by dismissal (#5106). */}
      <View style={styles.scrollFrame}>
        <ScrollView
          ref={attachTabStrip}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.scroll, inTopBar && styles.scrollInTopBar]}
          contentContainerStyle={[styles.scrollContent, inTopBar && styles.scrollContentInTopBar]}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScrollBeginDrag={cancelHeldReveal}
          onScroll={(e) => {
            offsetRef.current = e.nativeEvent.contentOffset.x
            refreshHiddenTabs()
          }}
          onLayout={(e) => {
            viewportWidthRef.current = e.nativeEvent.layout.width
            scrollActiveTabIntoView(activeTabIdRef.current, false)
            refreshHiddenTabs()
          }}
          onContentSizeChange={(width) => {
            contentWidthRef.current = width
            scrollActiveTabIntoView(activeTabIdRef.current, false)
            refreshHiddenTabs()
          }}
        >
          {rows.map((row, index) => {
            const { tab, title } = row
            const isActive = tab.id === activeSessionTabId
            const status = row.dotState && row.dotState !== 'idle' ? row.dotState : undefined
            const unreadBell = row.unread && row.group === 'other'
            const baseLabel = isForkedChatTab(tab) ? mobileForkAccessibleName(title) : title
            return (
              <Pressable
                key={tab.id}
                style={({ pressed }) => [
                  styles.tab,
                  index === 0 && !inTopBar && styles.tabFirst,
                  isActive && styles.tabActive,
                  pressed && styles.tabPressed
                ]}
                onLayout={(e) => {
                  const { x, width } = e.nativeEvent.layout
                  tabLayoutsRef.current.set(tab.id, { x, width })
                  if (tab.id === activeTabIdRef.current) {
                    scrollActiveTabIntoView(tab.id, false)
                  }
                  refreshHiddenTabs()
                }}
                onPress={() => pressTab(tab)}
                accessibilityRole="tab"
                accessibilityLabel={[
                  baseLabel,
                  unreadBell ? t('agents.list.unread', 'Unread') : null,
                  status ? agentStateLabel(status) : null
                ]
                  .filter(Boolean)
                  .join(', ')}
                accessibilityState={{ selected: isActive }}
                onLongPress={() => {
                  triggerMediumImpact()
                  openSessionTabActionSheetAfterKeyboardDismiss(tab)
                }}
                delayLongPress={400}
              >
                <View style={styles.tabLabelRow}>
                  <StripTabDot tabId={tab.id} state={row.dotState} unreadBell={unreadBell} />
                  <View style={styles.tabIcon}>
                    <MobileSessionTabMark row={row} size={13} />
                  </View>
                  <Text
                    style={[styles.tabText, isActive && styles.tabTextActive]}
                    numberOfLines={1}
                  >
                    {isForkedChatTab(tab) ? <MobileForkMarkedName name={title} /> : title}
                  </Text>
                </View>
              </Pressable>
            )
          })}
        </ScrollView>
        {leftHint ? (
          <View pointerEvents="none" style={[styles.edgeHint, styles.edgeHintLeft]}>
            <TabStripEdgeBadge hint={leftHint} />
          </View>
        ) : null}
        {rightHint ? (
          <View pointerEvents="none" style={[styles.edgeHint, styles.edgeHintRight]}>
            <TabStripEdgeBadge hint={rightHint} />
          </View>
        ) : null}
      </View>
      <MobileSessionTabCountButton
        count={rows.length}
        anyUnread={anyUnread}
        othersNeedYou={othersNeedYou}
        active={showRecentSessionCards}
        leadingBorder
        isLastCell={!showNewTab && !inTopBar}
        onPress={() => setShowRecentSessionCards(true)}
      />
      {showNewTab ? (
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
        visible={showRecentSessionCards}
        initialScope="recent"
        stickyScope={false}
        onClose={() => setShowRecentSessionCards(false)}
      />
    </View>
  )
}
