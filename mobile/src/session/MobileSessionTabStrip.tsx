import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { View, ScrollView } from 'react-native'
import { Plus } from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { AgentStateDot } from '../components/AgentStateDot'
import { useNow } from '../hooks/use-now'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import {
  getMobileTerminalTabHostAgentIdentity,
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { QuickCommandsTabButton } from './QuickCommandsTabButton'
import {
  resolveTabStripEdgeHint,
  resolveTabStripHiddenTabs,
  resolveTabStripTapOffset,
  type TabStripHiddenTabs
} from './tab-strip-scroll'
import { styles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionController } from './use-mobile-session-controller'

import { MobileSessionTab } from './MobileSessionTab'
import type { SessionTitleCard } from './use-session-title-card'

const DOUBLE_TAP_RENAME_MS = 300

export const MobileSessionTabStrip = memo(function MobileSessionTabStrip({
  controller,
  inTopBar,
  details
}: {
  controller: MobileSessionController
  inTopBar: boolean
  details: SessionTitleCard['tabDetails']
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
    setShowQuickCommands,
    quickCommandsSupported,
    showToast,
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
  const stripBarRef = useRef<View>(null)
  const tabBarRef = inTopBar ? details.barRef : stripBarRef
  const { dismiss, toggleSource, refreshSource } = details
  const tabBarKeepsKeyboard = useKeyboardPersistingTaps('handled')
  const attachTabBar = useCallback(
    (view: View | null) => {
      stripBarRef.current = view
      tabBarKeepsKeyboard(view)
    },
    [tabBarKeepsKeyboard]
  )
  const lastTabTapRef = useRef<{ id: string; at: number } | null>(null)
  const now = useNow(60_000)
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
    (t: (typeof visibleTabs)[number], source: Parameters<typeof toggleSource>[0]) => {
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
        dismiss()
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
      toggleSource(source)
    },
    [
      activeHandleRef,
      dismiss,
      toggleSource,
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
    <View
      ref={attachTabBar}
      onLayout={() => refreshSource()}
      style={inTopBar ? styles.tabBarInTopBar : styles.tabBar}
    >
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
          onScrollBeginDrag={() => {
            cancelHeldTabStripReveal()
            dismiss()
          }}
          onScroll={(e) => {
            tabStripOffsetRef.current = e.nativeEvent.contentOffset.x
            refreshHiddenTabs()
            refreshSource()
          }}
          onLayout={(e) => {
            tabStripViewportWidthRef.current = e.nativeEvent.layout.width
            scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
            refreshHiddenTabs()
            refreshSource()
          }}
          onContentSizeChange={(width) => {
            tabStripContentWidthRef.current = width
            scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
            refreshHiddenTabs()
            refreshSource()
          }}
        >
          {visibleTabs.map((tab, index) => {
            const tabState = tabStates.get(tab.id)
            const { title, agentId } = tabLabels[index]
            return (
              <MobileSessionTab
                key={tab.id}
                tab={tab}
                first={index === 0 && !inTopBar}
                active={tab.id === activeSessionTabId}
                title={title}
                tabState={tabState}
                agentId={agentId}
                details={details}
                barRef={tabBarRef}
                onLayout={(e) => {
                  const { x, width } = e.nativeEvent.layout
                  tabLayoutsRef.current.set(tab.id, { x, width })
                  if (tab.id === activeSessionTabIdRef.current) {
                    scrollActiveTabIntoView(tab.id, false)
                  }
                  refreshHiddenTabs()
                }}
                onPress={(source) => pressTab(tab, source)}
                onLongPress={() => {
                  dismiss()
                  triggerMediumImpact()
                  openSessionTabActionSheetAfterKeyboardDismiss(tab)
                }}
              />
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
      {/* Why: pinned outside the scroll strip so the new-agent button stays reachable however far the tabs scroll. */}
      <MobileSessionHeaderIconButton
        disabled={creating || creatingBrowser || creatingMarkdown || connState !== 'connected'}
        onPress={() => {
          setCreateError('')
          setShowCreateTabDrawer(true)
        }}
        accessibilityLabel={t('session.tabStrip.newTab', 'New tab')}
        icon={Plus}
      />
      {/* Why: stable placement matters, while old hosts must stay gated because they strip agentPrompt. */}
      <QuickCommandsTabButton
        disabled={creating || creatingBrowser || creatingMarkdown || connState !== 'connected'}
        onPress={() => {
          if (quickCommandsSupported === true) {
            setShowQuickCommands(true)
            return
          }
          showToast(
            quickCommandsSupported === false
              ? t(
                  'session.tabStrip.quickCommandsUpdateRequired',
                  'Desktop update required for quick commands'
                )
              : t(
                  'session.tabStrip.checkingCapabilities',
                  'Checking desktop capabilities — try again in a moment'
                ),
            1600
          )
        }}
      />
    </View>
  )
})
