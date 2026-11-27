import { useCallback, useEffect, useRef } from 'react'
import {
  currentSoftKeyboardHeight,
  subscribeSoftKeyboard
} from '../../../platform/keyboard/keyboard-occlusion'
import { useTerminalViewportRefit } from '../../viewport/terminal-viewport-refit'
import { removeCustomKey, type CustomKey } from '../../key-input/terminal-custom-keys'
import { useWorkspaceExecutionHost } from '../../../navigation/workspace-execution-host'
import { getMobileTerminalTabHostAgentIdentity } from '../../../session/tabs/mobile-terminal-tab-agent'
import {
  buildRecentSessionCardFromTab,
  hydrateRecentSessionCards,
  reconcileRecentSessionCardsForWorktree,
  recordRecentSessionCardVisit
} from '../../../session/recent-session-cards'
import { writeLastVisitedWorktree } from '../../../worktree/navigation/last-visited-worktree-by-host'
import type { MobileSessionLifecycleModel } from '../../../session/use-mobile-session-lifecycle'

export type MobileSessionKeyboardScope = Pick<
  MobileSessionLifecycleModel,
  | 'activeHandleRef'
  | 'activeSessionTabId'
  | 'visibleTerminalHandlesRef'
  | 'terminalPaneViewportsRef'
  | 'clientRef'
  | 'connState'
  | 'deviceTokenRef'
  | 'hostId'
  | 'router'
  | 'sessionTabs'
  | 'setCustomKeys'
  | 'setShowCustomKeyModal'
  | 'showNativeChatRef'
  | 'subscribeToTerminal'
  | 'terminalFrameRef'
  | 'terminalRefs'
  | 'terminals'
  | 'terminalTextScale'
  | 'terminalFontStyle'
  | 'unsubscribeTerminal'
  | 'viewportMeasuredRef'
  | 'viewportRef'
  | 'worktreeId'
  | 'worktreeName'
>

export function useMobileSessionKeyboardState(scope: MobileSessionKeyboardScope) {
  const {
    hostId,
    worktreeId,
    worktreeName,
    router,
    connState,
    sessionTabs,
    activeSessionTabId,
    terminals,
    terminalTextScale,
    terminalFontStyle,
    setCustomKeys,
    setShowCustomKeyModal,
    deviceTokenRef,
    clientRef,
    viewportRef,
    viewportMeasuredRef,
    terminalRefs,
    activeHandleRef,
    visibleTerminalHandlesRef,
    terminalPaneViewportsRef,
    terminalFrameRef,
    showNativeChatRef,
    unsubscribeTerminal,
    subscribeToTerminal
  } = scope
  const {
    notifyTerminalFrameHeight,
    notifyTerminalFrameWidth,
    notifyKeyboardVisibility,
    notifyTerminalCellBoxChange
  } = useTerminalViewportRefit({
    activeHandleRef,
    visibleTerminalHandlesRef,
    terminalPaneViewportsRef,
    terminalRefs,
    terminalFrameRef,
    viewportRef,
    viewportMeasuredRef,
    nativeChatCoveredRef: showNativeChatRef,
    clientRef,
    deviceTokenRef,
    connState,
    tabStripVisible: terminals.length > 1,
    fontMetricsKey: `${terminalTextScale}/${terminalFontStyle.font}/${terminalFontStyle.lineHeight}/${terminalFontStyle.weight}`,
    unsubscribeTerminal,
    subscribeToTerminal
  })

  // Use the keyboard seam because web Keyboard emits nothing; visibility goes out with the event, before the lift renders, so refits defer while it opens.
  useEffect(() => {
    notifyKeyboardVisibility(currentSoftKeyboardHeight() > 0)
    return subscribeSoftKeyboard(
      () => notifyKeyboardVisibility(true),
      () => notifyKeyboardVisibility(false)
    )
  }, [notifyKeyboardVisibility])

  const executionHost = useWorkspaceExecutionHost()
  useEffect(() => {
    if (hostId && worktreeId) {
      void writeLastVisitedWorktree({ hostId, worktreeId, executionHost })
    }
  }, [hostId, worktreeId, executionHost])

  useEffect(() => {
    void hydrateRecentSessionCards().catch(() => {})
  }, [])

  const lastRecordedCardKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!hostId || !worktreeId) {
      return
    }
    if (sessionTabs.length > 0) {
      reconcileRecentSessionCardsForWorktree({
        hostId,
        worktreeId,
        executionHost,
        liveTabs: sessionTabs
      })
    }
    if (!activeSessionTabId) {
      return
    }
    const activeTab = sessionTabs.find((tab) => tab.id === activeSessionTabId)
    if (!activeTab) {
      return
    }
    const hostAgentIdentity = getMobileTerminalTabHostAgentIdentity(activeTab, terminals)
    // Status receipts rewrite sessionTabs without a new user visit.
    const recordedKey = [
      hostId,
      executionHost ?? '',
      worktreeId,
      activeTab.id,
      activeTab.title,
      worktreeName,
      hostAgentIdentity ?? ''
    ].join('\0')
    if (lastRecordedCardKeyRef.current === recordedKey) {
      return
    }
    lastRecordedCardKeyRef.current = recordedKey
    recordRecentSessionCardVisit(
      buildRecentSessionCardFromTab({
        hostId,
        executionHost,
        worktreeId,
        worktreeName: worktreeName || '',
        tab: activeTab,
        hostAgentIdentity
      })
    )
  }, [activeSessionTabId, executionHost, hostId, sessionTabs, terminals, worktreeId, worktreeName])

  const handleDeleteCustomKey = useCallback(async (key: CustomKey) => {
    try {
      setCustomKeys(await removeCustomKey(key.id))
    } catch (error) {
      console.warn('[custom-keys] the store would not take this removal', error)
    }
  }, [])

  const handleManageShortcuts = useCallback(() => {
    setShowCustomKeyModal(false)
    router.push('/terminal-settings')
  }, [router])
  return {
    notifyTerminalFrameHeight,
    notifyTerminalFrameWidth,
    notifyKeyboardVisibility,
    notifyTerminalCellBoxChange,
    handleDeleteCustomKey,
    handleManageShortcuts
  }
}

export type MobileSessionKeyboardStateModel = MobileSessionLifecycleModel &
  ReturnType<typeof useMobileSessionKeyboardState>
