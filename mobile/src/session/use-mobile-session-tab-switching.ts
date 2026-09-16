import { useCallback } from 'react'
import { triggerSelection } from '../platform/haptics'
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileSessionTabSwitching(scope: MobileSessionKeyboardStateModel) {
  const {
    worktreeId,
    client,
    sessionTabs,
    defaultTerminalHandlesToLiveInput,
    setActiveHandle,
    setActiveSessionTabId,
    markdownDocs,
    terminalUnsubsRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingActiveSessionTabIdRef,
    pendingActiveTerminalHandleRef,
    switchSessionTabRef,
    unsubscribeTerminal,
    subscribeToTerminal,
    readMarkdownTab,
    readFileTab
  } = scope
  // Why: unsubscribe restores old dims (clears phone-fit banner); resubscribe phone-fits the new one.
  const switchTab = useCallback(
    (handle: string) => {
      triggerSelection()
      const matchingTab = sessionTabs.find(
        (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
          tab.type === 'terminal' && tab.terminal === handle
      )
      terminalDiagnosticsRef.current.tabSwitch('terminal', matchingTab?.id ?? '', false, handle)
      pendingActiveSessionTabIdRef.current = matchingTab?.id ?? null
      pendingActiveTerminalHandleRef.current = handle
      activeSessionTabTypeRef.current = 'terminal'
      defaultTerminalHandlesToLiveInput([handle])
      setActiveSessionTabId(matchingTab?.id ?? null)
      const prev = activeHandleRef.current
      activeHandleRef.current = handle
      setActiveHandle(handle)
      if (prev && prev !== handle) {
        unsubscribeTerminal(prev)
        initializedHandlesRef.current.delete(prev)
      }
      // Force a fresh subscribe even if eagerly subscribed without viewport
      if (terminalUnsubsRef.current.has(handle)) {
        unsubscribeTerminal(handle)
        initializedHandlesRef.current.delete(handle)
      }
      subscribeToTerminal(handle)
      if (client) {
        if (matchingTab) {
          void activateMobileSessionTab(client, {
            worktree: `id:${worktreeId}`,
            tabId: matchingTab.id,
            notifyClients: false,
            navigation: 'caller',
            intent: 'user'
          }).catch(() => {})
        }
      }
    },
    [
      client,
      defaultTerminalHandlesToLiveInput,
      sessionTabs,
      subscribeToTerminal,
      unsubscribeTerminal,
      worktreeId
    ]
  )

  const switchSessionTab = useCallback(
    (tab: MobileSessionTab) => {
      if (tab.type === 'terminal') {
        if (typeof tab.terminal === 'string') {
          switchTab(tab.terminal)
          return
        }
        terminalDiagnosticsRef.current.tabSwitch('terminal', tab.id, true)
        triggerSelection()
        pendingActiveSessionTabIdRef.current = tab.id
        pendingActiveTerminalHandleRef.current = null
        activeSessionTabTypeRef.current = 'terminal'
        setActiveSessionTabId(tab.id)
        const prev = activeHandleRef.current
        if (prev) {
          unsubscribeTerminal(prev)
          initializedHandlesRef.current.delete(prev)
        }
        activeHandleRef.current = null
        setActiveHandle(null)
        if (client) {
          void activateMobileSessionTab(client, {
            worktree: `id:${worktreeId}`,
            tabId: tab.id,
            notifyClients: false,
            navigation: 'caller',
            intent: 'user'
          }).catch(() => {})
        }
        return
      }

      triggerSelection()
      terminalDiagnosticsRef.current.tabSwitch(tab.type, tab.id, false)
      pendingActiveSessionTabIdRef.current = tab.id
      pendingActiveTerminalHandleRef.current = null
      activeSessionTabTypeRef.current = tab.type
      setActiveSessionTabId(tab.id)
      const prev = activeHandleRef.current
      if (prev) {
        unsubscribeTerminal(prev)
        initializedHandlesRef.current.delete(prev)
      }
      activeHandleRef.current = null
      setActiveHandle(null)
      if (client) {
        void activateMobileSessionTab(client, {
          worktree: `id:${worktreeId}`,
          tabId: tab.id,
          notifyClients: false,
          navigation: 'caller',
          intent: 'user'
        }).catch(() => {})
      }
      if (tab.type === 'browser') {
        return
      }
      if (tab.type === 'file') {
        void readFileTab(tab)
        return
      }
      if (tab.type === 'agent-session') {
        return
      }
      const cached = markdownDocs.get(tab.id)
      if (cached?.status === 'ready' && cached.isDirty) {
        return
      }
      // Why: tab list lacks a reliable version for desktop clean saves; re-read on revisit unless the phone has a draft.
      void readMarkdownTab(tab)
    },
    [client, markdownDocs, readFileTab, readMarkdownTab, switchTab, unsubscribeTerminal, worktreeId]
  )
  // Ref to latest switchSessionTab so fetchSessionTabs can activate a synced browser tab without a dependency cycle.
  switchSessionTabRef.current = switchSessionTab
  return {
    switchTab,
    switchSessionTab
  }
}

export type MobileSessionTabSwitchingModel = MobileSessionKeyboardStateModel &
  ReturnType<typeof useMobileSessionTabSwitching>
