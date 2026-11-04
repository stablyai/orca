import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { File, FileText, Globe, History, Plus, SquareTerminal } from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { AgentStateDot } from '../components/AgentStateDot'
import { useNow } from '../hooks/use-now'
import { agentStateLabel, type AgentDotState } from '../worktree/agent-row-display'
import {
  clearLatchedUnreadTabKeys,
  getMobileTerminalTabHostAgentIdentity,
  getMobileSessionTabTitle,
  hasPendingWorktreeUnreadForTabCompletion,
  isMobileSessionTabUnreadBeforeView,
  latchInitialActiveTabUnread,
  resolveMobileSessionTabDotState,
  resolveMobileTerminalTabAgentId,
  seedUnreadWorktreeSessionTabs,
  subscribeCatalogWorktreesForTabStatus
} from './mobile-terminal-tab-agent'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import {
  resolveTabStripEdgeHint,
  resolveTabStripHiddenTabs,
  resolveTabStripTapOffset,
  type TabStripHiddenTabs
} from './tab-strip-scroll'
import { styles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionController } from './use-mobile-session-controller'

const DOUBLE_TAP_RENAME_MS = 300

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
    activeSessionTabIdRef,
    tabStripRef,
    tabStripOffsetRef,
    tabStripViewportWidthRef,
    tabStripContentWidthRef,
    tabLayoutsRef,
    connState,
    createTabBusy,
    handleOpenNewTab,
    showRecentSessionCardsAction,
    showRecentSessionCards,
    setShowRecentSessionCards,
    scrollActiveTabIntoView,
    holdTabStripReveal,
    cancelHeldTabStripReveal,
    switchSessionTab,
    openSessionTabActionSheetAfterKeyboardDismiss,
    setRenameTarget,
    activeHandleRef,
    visibleTabs,
    terminals
  } = controller
  const tabBarKeepsKeyboard = useKeyboardPersistingTaps('handled')
  const lastTabTapRef = useRef<{ id: string; at: number } | null>(null)
  const visitUnreadRef = useRef<{
    worktreeId: string | null | undefined
    userSwitchedTab: boolean
    checkedActiveTabIds: Set<string>
    latchedUnreadTabId: string | null
  }>({
    worktreeId: undefined,
    userSwitchedTab: false,
    checkedActiveTabIds: new Set(),
    latchedUnreadTabId: null
  })
  if (visitUnreadRef.current.worktreeId !== controller.worktreeId) {
    if (visitUnreadRef.current.latchedUnreadTabId) {
      clearLatchedUnreadTabKeys()
    }
    visitUnreadRef.current = {
      worktreeId: controller.worktreeId,
      userSwitchedTab: false,
      checkedActiveTabIds: new Set(),
      latchedUnreadTabId: null
    }
  }
  useEffect(
    () => () => {
      if (visitUnreadRef.current.latchedUnreadTabId) {
        clearLatchedUnreadTabKeys()
      }
    },
    []
  )
  const now = useNow(60_000)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [visitEpoch, setVisitEpoch] = useState(0)
  useEffect(
    () => subscribeCatalogWorktreesForTabStatus(() => setCatalogRevision((rev) => rev + 1)),
    []
  )
  const tabStates = useMemo(() => {
    void catalogRevision
    void visitEpoch
    const states = new Map<string, AgentDotState>()
    const visit = visitUnreadRef.current
    if (
      visit.latchedUnreadTabId !== null &&
      activeSessionTabId !== null &&
      activeSessionTabId !== visit.latchedUnreadTabId
    ) {
      visit.userSwitchedTab = true
      visit.latchedUnreadTabId = null
      clearLatchedUnreadTabKeys()
    }
    if (visibleTabs.length > 0 && hasPendingWorktreeUnreadForTabCompletion(controller.worktreeId)) {
      seedUnreadWorktreeSessionTabs(controller.worktreeId, visibleTabs, now)
    }
    for (const tab of visibleTabs) {
      const tabId = tab.id
      const isActive = tabId === activeSessionTabId
      let state: AgentDotState | undefined
      if (
        isActive &&
        !visit.userSwitchedTab &&
        !visit.latchedUnreadTabId &&
        !visit.checkedActiveTabIds.has(tabId)
      ) {
        const unreadBeforeView = isMobileSessionTabUnreadBeforeView(tab, now, tabId)
        state = resolveMobileSessionTabDotState(tab, now, { isActiveOnScreen: true, tabId })
        if (unreadBeforeView) {
          visit.latchedUnreadTabId = tabId
          visit.checkedActiveTabIds.add(tabId)
          latchInitialActiveTabUnread(tab, tabId)
        } else if (state !== undefined) {
          visit.checkedActiveTabIds.add(tabId)
        }
      } else {
        state = resolveMobileSessionTabDotState(tab, now, { isActiveOnScreen: isActive, tabId })
      }
      if (!visit.userSwitchedTab && visit.latchedUnreadTabId === tabId) {
        if (state === 'done') {
          states.set(tabId, 'unread')
        } else {
          visit.latchedUnreadTabId = null
          clearLatchedUnreadTabKeys()
          if (state) {
            states.set(tabId, state)
          }
        }
      } else if (state) {
        states.set(tabId, state)
      }
    }
    return states
  }, [visibleTabs, now, activeSessionTabId, catalogRevision, controller.worktreeId, visitEpoch])
  const tabLabels = useMemo(
    () =>
      visibleTabs.map((tab) => {
        const identity = getMobileTerminalTabHostAgentIdentity(tab, terminals)
        return {
          title: getMobileSessionTabTitle(tab, identity),
          agentId:
            tab.type === 'agent-session'
              ? tab.agent
              : tab.type === 'terminal'
                ? resolveMobileTerminalTabAgentId(tab, identity)
                : null
        }
      }),
    [visibleTabs, terminals, t]
  )
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
  const pressTab = useCallback(
    (t: (typeof visibleTabs)[number]) => {
      visitUnreadRef.current.userSwitchedTab = true
      visitUnreadRef.current.latchedUnreadTabId = null
      clearLatchedUnreadTabKeys()
      setVisitEpoch((epoch) => epoch + 1)
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
      const nextOffset = resolveTabStripTapOffset({
        tabId: t.id,
        tabs: visibleTabs,
        layouts: tabLayoutsRef.current,
        viewportWidth: tabStripViewportWidthRef.current,
        contentWidth: tabStripContentWidthRef.current,
        currentOffset: tabStripOffsetRef.current
      })
      if (nextOffset !== tabStripOffsetRef.current) {
        holdTabStripReveal(nextOffset, DOUBLE_TAP_RENAME_MS)
      }
      switchSessionTab(t)
    },
    [
      activeHandleRef,
      cancelHeldTabStripReveal,
      holdTabStripReveal,
      setRenameTarget,
      switchSessionTab,
      tabLayoutsRef,
      tabStripContentWidthRef,
      tabStripOffsetRef,
      tabStripRef,
      tabStripViewportWidthRef,
      visibleTabs
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
  return (
    <View ref={tabBarKeepsKeyboard} style={inTopBar ? styles.tabBarInTopBar : styles.tabBar}>
      {/* Why: tab taps must register on first press with the keyboard open instead of being eaten by dismissal (#5106). */}
      <View style={styles.tabScrollFrame}>
        <ScrollView
          ref={attachTabStrip}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.tabScroll, inTopBar && styles.tabScrollInTopBar]}
          contentContainerStyle={[styles.tabContent, inTopBar && styles.tabContentInTopBar]}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScrollBeginDrag={cancelHeldTabStripReveal}
          onScroll={(e) => {
            tabStripOffsetRef.current = e.nativeEvent.contentOffset.x
            refreshHiddenTabs()
          }}
          onLayout={(e) => {
            tabStripViewportWidthRef.current = e.nativeEvent.layout.width
            scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
            refreshHiddenTabs()
          }}
          onContentSizeChange={(width) => {
            tabStripContentWidthRef.current = width
            scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
            refreshHiddenTabs()
          }}
        >
          {visibleTabs.map((tab, index) => {
            const tabState = tabStates.get(tab.id)
            const { title, agentId } = tabLabels[index]
            return (
              <Pressable
                key={tab.id}
                style={({ pressed }) => [
                  styles.tab,
                  index === 0 && !inTopBar && styles.tabFirst,
                  tab.id === activeSessionTabId && styles.tabActive,
                  pressed && styles.tabPressed
                ]}
                onLayout={(e) => {
                  const { x, width } = e.nativeEvent.layout
                  tabLayoutsRef.current.set(tab.id, { x, width })
                  if (tab.id === activeSessionTabIdRef.current) {
                    scrollActiveTabIntoView(tab.id, false)
                  }
                  refreshHiddenTabs()
                }}
                onPress={() => pressTab(tab)}
                accessibilityRole="tab"
                accessibilityLabel={
                  tabState && tabState !== 'idle'
                    ? t('session.tabStrip.tabStatus', '{{title}}, {{status}}', {
                        title,
                        status: agentStateLabel(tabState)
                      })
                    : title
                }
                accessibilityState={{ selected: tab.id === activeSessionTabId }}
                onLongPress={() => {
                  triggerMediumImpact()
                  openSessionTabActionSheetAfterKeyboardDismiss(tab)
                }}
                delayLongPress={400}
              >
                <View style={styles.tabLabelRow}>
                  {tabState && tabState !== 'idle' ? <AgentStateDot state={tabState} /> : null}
                  <View style={styles.tabIcon}>
                    {tab.type === 'browser' && (
                      <Globe size={13} color={colors.textSecondary} strokeWidth={2.1} />
                    )}
                    {tab.type === 'markdown' && (
                      <FileText size={13} color={colors.textSecondary} strokeWidth={2.1} />
                    )}
                    {tab.type === 'file' && (
                      <File size={13} color={colors.textSecondary} strokeWidth={2.1} />
                    )}
                    {tab.type === 'agent-session' && agentId ? (
                      <MobileAgentIcon agentId={agentId} size={13} />
                    ) : null}
                    {tab.type === 'terminal' &&
                      (agentId ? (
                        <MobileAgentIcon agentId={agentId} size={13} />
                      ) : (
                        <SquareTerminal
                          size={13}
                          color={colors.textSecondary}
                          strokeWidth={2.1}
                        />
                      ))}
                  </View>
                  <Text
                    style={[styles.tabText, tab.id === activeSessionTabId && styles.tabTextActive]}
                    numberOfLines={1}
                  >
                    {title}
                  </Text>
                </View>
              </Pressable>
            )
          })}
        </ScrollView>
        {leftHint ? (
          <View pointerEvents="none" style={[styles.tabEdgeHint, styles.tabEdgeHintLeft]}>
            <AgentStateDot state={leftHint} />
          </View>
        ) : null}
        {rightHint ? (
          <View pointerEvents="none" style={[styles.tabEdgeHint, styles.tabEdgeHintRight]}>
            <AgentStateDot state={rightHint} />
          </View>
        ) : null}
      </View>
      {/* Terminal layout and Quick commands live in the header's ⋯ menu. */}
      {!actionsCollapsed ? (
        <View style={newTabStyles.slot}>
          <NavBarButton
            disabled={createTabBusy || connState !== 'connected'}
            onPress={handleOpenNewTab}
            accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
            icon={Plus}
          />
          {showRecentSessionCardsAction ? (
            <NavBarButton
              active={Boolean(showRecentSessionCards)}
              onPress={() => setShowRecentSessionCards(true)}
              accessibilityLabel={t('recentSessionCardsSectionTitle', 'Recently Used')}
              icon={History}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

// The right inset matches the nav bar's, so the + lines up with the ⋯ above it.
const newTabStyles = StyleSheet.create({
  slot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: spacing.md
  }
})
