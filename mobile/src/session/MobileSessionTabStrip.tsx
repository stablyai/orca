import { useCallback, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable } from 'react-native'
import { File, FileText, Globe, Plus, SquareTerminal } from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { AgentStateDot } from '../components/AgentStateDot'
import { useNow } from '../hooks/use-now'
import { agentDotState, agentStateLabel, type AgentDotState } from '../worktree/agent-row-display'
import {
  getMobileTerminalTabHostAgentIdentity,
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'
import { colors } from '../theme/mobile-theme'
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

const DOUBLE_TAP_RENAME_MS = 300

export function MobileSessionTabStrip({
  controller,
  inTopBar
}: {
  controller: MobileSessionController
  inTopBar: boolean
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
  const tabBarKeepsKeyboard = useKeyboardPersistingTaps('handled')
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
            const hostAgentIdentity = getMobileTerminalTabHostAgentIdentity(tab, terminals)
            const title = getMobileSessionTabTitle(tab, hostAgentIdentity)
            return (
              <Pressable
                key={tab.id}
                style={[
                  styles.tab,
                  index === 0 && !inTopBar && styles.tabFirst,
                  tab.id === activeSessionTabId && styles.tabActive
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
                    {tab.type === 'agent-session' && (
                      <MobileAgentIcon agentId={tab.agent} size={13} />
                    )}
                    {tab.type === 'terminal' &&
                      (() => {
                        const agentId = resolveMobileTerminalTabAgentId(tab, hostAgentIdentity)
                        return agentId ? (
                          <MobileAgentIcon agentId={agentId} size={13} />
                        ) : (
                          <SquareTerminal
                            size={13}
                            color={colors.textSecondary}
                            strokeWidth={2.1}
                          />
                        )
                      })()}
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
}
