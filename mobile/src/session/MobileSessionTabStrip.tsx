import { useCallback } from 'react'
import { View, Text, ScrollView, Pressable } from 'react-native'
import { File, FileText, Globe, Plus } from 'lucide-react-native'
import { triggerMediumImpact } from '../platform/haptics'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'
import { colors } from '../theme/mobile-theme'
import { QuickCommandsTabButton } from './QuickCommandsTabButton'
import { styles } from './mobile-session-styles'
import { useKeyboardPersistingTaps } from '../platform/keyboard-persisting-taps'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionTabStrip({
  controller,
  inTopBar
}: {
  controller: MobileSessionController
  inTopBar: boolean
}) {
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
    switchSessionTab,
    openSessionTabActionSheetAfterKeyboardDismiss,
    visibleTabs
  } = controller
  const tabBarKeepsKeyboard = useKeyboardPersistingTaps('handled')
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
      <ScrollView
        ref={attachTabStrip}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.tabScroll, inTopBar && styles.tabScrollInTopBar]}
        contentContainerStyle={[styles.tabContent, inTopBar && styles.tabContentInTopBar]}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(e) => {
          tabStripOffsetRef.current = e.nativeEvent.contentOffset.x
        }}
        onLayout={(e) => {
          tabStripViewportWidthRef.current = e.nativeEvent.layout.width
          scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
        }}
        onContentSizeChange={(width) => {
          tabStripContentWidthRef.current = width
          scrollActiveTabIntoView(activeSessionTabIdRef.current, false)
        }}
      >
        {visibleTabs.map((t, index) => (
          <Pressable
            key={t.id}
            style={[
              styles.tab,
              index === 0 && !inTopBar && styles.tabFirst,
              t.id === activeSessionTabId && styles.tabActive
            ]}
            onLayout={(e) => {
              const { x, width } = e.nativeEvent.layout
              tabLayoutsRef.current.set(t.id, { x, width })
              if (t.id === activeSessionTabIdRef.current) {
                scrollActiveTabIntoView(t.id, false)
              }
            }}
            onPress={() => switchSessionTab(t)}
            onLongPress={() => {
              triggerMediumImpact()
              openSessionTabActionSheetAfterKeyboardDismiss(t)
            }}
            delayLongPress={400}
          >
            <View style={styles.tabLabelRow}>
              {t.type === 'browser' && (
                <Globe size={13} color={colors.textSecondary} strokeWidth={2.1} />
              )}
              {t.type === 'markdown' && (
                <FileText size={13} color={colors.textSecondary} strokeWidth={2.1} />
              )}
              {t.type === 'file' && (
                <File size={13} color={colors.textSecondary} strokeWidth={2.1} />
              )}
              {t.type === 'agent-session' && <MobileAgentIcon agentId={t.agent} size={13} />}
              {t.type === 'terminal' &&
                (() => {
                  const agentId = resolveMobileTerminalTabAgentId(t)
                  return agentId ? <MobileAgentIcon agentId={agentId} size={13} /> : null
                })()}
              <Text
                style={[styles.tabText, t.id === activeSessionTabId && styles.tabTextActive]}
                numberOfLines={1}
              >
                {getMobileSessionTabTitle(t)}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
      {/* Why: pinned outside the scroll strip so the new-agent button stays reachable however far the tabs scroll. */}
      <Pressable
        style={({ pressed }) => [
          styles.newTerminalButton,
          pressed && styles.newTerminalButtonPressed,
          (creating || creatingBrowser || creatingMarkdown || connState !== 'connected') &&
            styles.newTerminalButtonDisabled
        ]}
        disabled={creating || creatingBrowser || creatingMarkdown || connState !== 'connected'}
        onPress={() => {
          setCreateError('')
          setShowCreateTabDrawer(true)
        }}
        accessibilityLabel="New tab"
      >
        <Plus size={16} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
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
              ? 'Desktop update required for quick commands'
              : 'Checking desktop capabilities — try again in a moment',
            1600
          )
        }}
      />
    </View>
  )
}
