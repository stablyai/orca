import { useCallback, useMemo, useRef, useState } from 'react'
import { View, ScrollView, Pressable, StyleSheet } from 'react-native'
import { Plus } from 'lucide-react-native'
import { triggerMediumImpact, triggerSelection } from '../platform/haptics'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'
import { useNow } from '../hooks/use-now'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import {
  getMobileTerminalTabHostAgentIdentity,
  getMobileSessionTabTitle
} from './mobile-terminal-tab-agent'
import { MobileSessionTabStripTab, TAB_DOT_COLORS, TAB_HEIGHT } from './MobileSessionTabStripTab'
import { colors, motion, radii, spacing } from '../theme/mobile-theme'
import {
  resolveTabStripCenteredOffset,
  resolveTabStripEdgeHint,
  resolveTabStripHiddenTabs,
  type TabStripHiddenTabs
} from './tab-strip-scroll'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionController } from './use-mobile-session-controller'

const DOUBLE_TAP_RENAME_MS = 300
const TRACK_HEIGHT = 40
const TRACK_PADDING = 3
const MIN_TAB_WIDTH = 148
// Past this many tabs a phone stops shrinking them and the track scrolls instead.
const TABS_THAT_FIT = 2.4
// The active tab grows by its close button, so the X never takes room from the title.
const ACTIVE_CLOSE_EXTRA = 30

/** Ghostty-style tabs: equal capsules in one rounded track, a sliding pill on the active one. */
export function MobileSessionTabStrip({ controller }: { controller: MobileSessionController }) {
  const {
    connState,
    activeSessionTabId,
    activeSessionTabIdRef,
    tabStripRef,
    tabStripOffsetRef,
    tabStripViewportWidthRef,
    tabStripContentWidthRef,
    tabLayoutsRef,
    creating,
    creatingBrowser,
    creatingMarkdown,
    setCreateError,
    setShowCreateTabDrawer,
    scrollActiveTabIntoView,
    holdTabStripReveal,
    cancelHeldTabStripReveal,
    switchSessionTab,
    openSessionTabActionSheetAfterKeyboardDismiss,
    handleCloseSessionTab,
    setRenameTarget,
    activeHandleRef,
    visibleTabs,
    terminals
  } = controller
  const tabBarKeepsKeyboard = useKeyboardPersistingTaps('handled')
  const lastTabTapRef = useRef<{ id: string; at: number } | null>(null)
  const now = useNow(60_000)
  const [trackWidth, setTrackWidth] = useState(0)
  const tabStates = useMemo(() => {
    const states = new Map<string, AgentDotState>()
    for (const tab of visibleTabs) {
      // Why: a status restored across a host restart is unconfirmed, so like desktop it shows no live state.
      if (tab.type === 'terminal' && tab.agentStatus && !tab.agentStatus.restoredUnconfirmed) {
        states.set(tab.id, agentDotState(tab.agentStatus, now))
      } else if (tab.type === 'agent-session' && tab.chatStatus) {
        states.set(tab.id, agentDotState(tab.chatStatus, now))
      }
    }
    return states
  }, [visibleTabs, now])
  const [hiddenTabs, setHiddenTabs] = useState<TabStripHiddenTabs>({ left: [], right: [] })
  const refreshHiddenTabs = () => {
    const next = resolveTabStripHiddenTabs({
      layouts: tabLayoutsRef.current,
      viewportWidth: tabStripViewportWidthRef.current,
      currentOffset: tabStripOffsetRef.current
    })
    // Why: scroll fires every frame; re-render only when a tab crosses an edge.
    setHiddenTabs((prev) =>
      prev.left.join('\n') === next.left.join('\n') &&
      prev.right.join('\n') === next.right.join('\n')
        ? prev
        : next
    )
  }
  const leftHint = resolveTabStripEdgeHint(hiddenTabs.left, tabStates)
  const rightHint = resolveTabStripEdgeHint(hiddenTabs.right, tabStates)

  const laneWidth = Math.max(0, trackWidth - TRACK_PADDING * 2)
  const tabWidth =
    laneWidth > 0
      ? Math.max(
          MIN_TAB_WIDTH,
          Math.floor((laneWidth - ACTIVE_CLOSE_EXTRA) / Math.min(visibleTabs.length, TABS_THAT_FIT))
        )
      : MIN_TAB_WIDTH
  const activeIndex = visibleTabs.findIndex((tab) => tab.id === activeSessionTabId)

  const pressTab = useCallback(
    (t: MobileSessionTab) => {
      const at = Date.now()
      const lastTap = lastTabTapRef.current
      lastTabTapRef.current = { id: t.id, at }
      if (
        lastTap?.id === t.id &&
        at - lastTap.at < DOUBLE_TAP_RENAME_MS &&
        t.type === 'terminal' &&
        typeof t.terminal === 'string'
      ) {
        lastTabTapRef.current = null
        triggerMediumImpact()
        setRenameTarget({
          handle: t.terminal,
          title: t.title,
          isActive: t.terminal === activeHandleRef.current
        })
        // The first tap's held reveal still runs once the window closes.
        return
      }
      cancelHeldTabStripReveal()
      const layout = tabLayoutsRef.current.get(t.id)
      if (layout) {
        const nextOffset = resolveTabStripCenteredOffset({
          tabX: layout.x,
          tabWidth: layout.width,
          viewportWidth: tabStripViewportWidthRef.current,
          contentWidth: tabStripContentWidthRef.current
        })
        if (nextOffset !== tabStripOffsetRef.current) {
          holdTabStripReveal(nextOffset, DOUBLE_TAP_RENAME_MS)
        }
      }
      if (t.id !== activeSessionTabIdRef.current) {
        triggerSelection()
      }
      switchSessionTab(t)
    },
    [
      activeHandleRef,
      activeSessionTabIdRef,
      cancelHeldTabStripReveal,
      holdTabStripReveal,
      setRenameTarget,
      switchSessionTab,
      tabLayoutsRef,
      tabStripContentWidthRef,
      tabStripOffsetRef,
      tabStripViewportWidthRef
    ]
  )
  const attachTabStrip = useCallback(
    (view: ScrollView | null) => {
      if (view) {
        tabStripOffsetRef.current = 0
        tabStripViewportWidthRef.current = 0
        tabStripContentWidthRef.current = 0
        tabLayoutsRef.current.clear()
      }
      tabStripRef.current = view
    },
    [
      tabStripRef,
      tabStripOffsetRef,
      tabStripViewportWidthRef,
      tabStripContentWidthRef,
      tabLayoutsRef
    ]
  )
  const createDisabled =
    creating || creatingBrowser || creatingMarkdown || connState !== 'connected'
  return (
    <View ref={tabBarKeepsKeyboard} style={styles.bar}>
      {/* Why: tab taps must register on first press with the keyboard open instead of being eaten by dismissal (#5106). */}
      <View style={styles.track}>
        <ScrollView
          ref={attachTabStrip}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.scroll}
          contentContainerStyle={styles.lane}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScrollBeginDrag={cancelHeldTabStripReveal}
          onScroll={(e) => {
            tabStripOffsetRef.current = e.nativeEvent.contentOffset.x
            refreshHiddenTabs()
          }}
          onLayout={(e) => {
            const width = e.nativeEvent.layout.width
            tabStripViewportWidthRef.current = width
            setTrackWidth((prev) => (prev === width ? prev : width))
            scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
            refreshHiddenTabs()
          }}
          onContentSizeChange={(width) => {
            tabStripContentWidthRef.current = width
            scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
            refreshHiddenTabs()
          }}
        >
          {activeIndex !== -1 && trackWidth > 0 ? (
            <View
              pointerEvents="none"
              style={[
                styles.activePill,
                {
                  width: tabWidth + ACTIVE_CLOSE_EXTRA,
                  transform: [{ translateX: activeIndex * tabWidth }]
                },
                slideTransition
              ]}
            />
          ) : null}
          {visibleTabs.map((t, index) => {
            const hostAgentIdentity = getMobileTerminalTabHostAgentIdentity(t, terminals)
            const active = t.id === activeSessionTabId
            return (
              <MobileSessionTabStripTab
                key={t.id}
                tab={t}
                title={getMobileSessionTabTitle(t, hostAgentIdentity)}
                hostAgentIdentity={hostAgentIdentity}
                state={tabStates.get(t.id)}
                active={active}
                dividerHidden={index === 0 || active || index - 1 === activeIndex}
                width={active ? tabWidth + ACTIVE_CLOSE_EXTRA : tabWidth}
                onLayout={(x, width) => {
                  tabLayoutsRef.current.set(t.id, { x, width })
                  if (t.id === activeSessionTabIdRef.current) {
                    scrollActiveTabIntoView(t.id, false)
                  }
                  refreshHiddenTabs()
                }}
                onPress={() => pressTab(t)}
                onLongPress={() => {
                  triggerMediumImpact()
                  openSessionTabActionSheetAfterKeyboardDismiss(t)
                }}
                onClose={() => void handleCloseSessionTab(t)}
              />
            )
          })}
        </ScrollView>
        {leftHint && TAB_DOT_COLORS[leftHint] ? (
          <View pointerEvents="none" style={[styles.edgeHint, styles.edgeHintLeft]}>
            <View style={[styles.statusDot, { backgroundColor: TAB_DOT_COLORS[leftHint] }]} />
          </View>
        ) : null}
        {rightHint && TAB_DOT_COLORS[rightHint] ? (
          <View pointerEvents="none" style={[styles.edgeHint, styles.edgeHintRight]}>
            <View style={[styles.statusDot, { backgroundColor: TAB_DOT_COLORS[rightHint] }]} />
          </View>
        ) : null}
      </View>
      {/* Why: pinned outside the scroll strip so the new-tab button stays reachable however far the tabs scroll. */}
      <Pressable
        disabled={createDisabled}
        onPress={() => {
          setCreateError('')
          setShowCreateTabDrawer(true)
        }}
        accessibilityRole="button"
        accessibilityLabel="New tab"
        accessibilityState={{ disabled: createDisabled }}
        style={[styles.addTouch, createDisabled && styles.disabled]}
      >
        {({ pressed }) => (
          <View
            style={[
              styles.add,
              pressed && styles.addPressed,
              pressed ? pressTransition.pressed : pressTransition.rest
            ]}
          >
            <Plus size={19} color={colors.textPrimary} strokeWidth={2.2} />
          </View>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: 2,
    paddingHorizontal: spacing.md,
    paddingBottom: 10
  },
  track: {
    flex: 1,
    minWidth: 0,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: 'rgba(255, 255, 255, 0.055)',
    overflow: 'hidden'
  },
  scroll: { flex: 1 },
  lane: { padding: TRACK_PADDING, flexGrow: 1 },
  activePill: {
    position: 'absolute',
    top: TRACK_PADDING,
    left: TRACK_PADDING,
    height: TAB_HEIGHT,
    borderRadius: TAB_HEIGHT / 2,
    backgroundColor: 'rgba(255, 255, 255, 0.13)',
    borderWidth: 0.5,
    borderColor: 'rgba(255, 255, 255, 0.1)'
  },
  statusDot: { width: 7, height: 7, borderRadius: 3.5, flexShrink: 0 },
  edgeHint: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  edgeHintLeft: { left: 0 },
  edgeHintRight: { right: 0 },
  addTouch: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  add: {
    width: TRACK_HEIGHT,
    height: TRACK_HEIGHT,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.fill
  },
  addPressed: { backgroundColor: colors.fillPressed, transform: [{ scale: 0.9 }] },
  disabled: { opacity: motion.disabledOpacity }
})
