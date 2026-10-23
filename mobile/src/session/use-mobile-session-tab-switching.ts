import { useCallback } from 'react'
import { STARTUP_CWD_FALLBACK_SENTENCE } from '../../../src/shared/startup-cwd-fallback'
import { triggerSelection } from '../platform/haptics'
import type { RpcResponse } from '../transport/types'
import { isCachedActiveDocumentRetap } from './mobile-session-active-document-retap'
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import { activatedAtWorkspaceRoot } from './session-write-reply-schema'
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
    activeSessionTabId,
    markdownDocs,
    fileDocs,
    terminalUnsubsRef,
    terminalDiagnosticsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
    switchSessionTabRef,
    unsubscribeTerminal,
    subscribeToTerminal,
    readMarkdownTab,
    readFileTab,
    showToast
  } = scope
  const reportActivation = useCallback(
    (response: RpcResponse) => {
      if (response.ok && activatedAtWorkspaceRoot(response.result)) {
        showToast(STARTUP_CWD_FALLBACK_SENTENCE, 1800)
      }
    },
    [showToast]
  )
  // Why: unsubscribe restores old dims (clears phone-fit banner); resubscribe phone-fits the new one.
  const switchTab = useCallback(
    (handle: string) => {
      triggerSelection()
      const matchingTab = sessionTabs.find(
        (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
          tab.type === 'terminal' && tab.terminal === handle
      )
      terminalDiagnosticsRef.current.tabSwitch('terminal', matchingTab?.id ?? '', false, handle)
      pendingSelectionRef.current = { kind: 'terminal', handle, tabId: matchingTab?.id ?? null }
      activeSessionTabTypeRef.current = 'terminal'
      defaultTerminalHandlesToLiveInput([handle])
      setActiveSessionTabId(matchingTab?.id ?? null)
      const prev = activeHandleRef.current
      activeHandleRef.current = handle
      setActiveHandle(handle)
      if (prev && prev !== handle) {
        unsubscribeTerminal(prev)
      }
      // Force a fresh subscribe even if eagerly subscribed without viewport
      if (terminalUnsubsRef.current.has(handle)) {
        unsubscribeTerminal(handle)
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
          })
            .then(reportActivation)
            .catch(() => {})
        }
      }
    },
    [
      client,
      defaultTerminalHandlesToLiveInput,
      reportActivation,
      sessionTabs,
      subscribeToTerminal,
      unsubscribeTerminal,
      worktreeId
    ]
  )

  const switchSessionTab = useCallback(
    (tab: MobileSessionTab) => {
      if (isCachedActiveDocumentRetap(tab, activeSessionTabId, { markdownDocs, fileDocs })) {
        return
      }
      if (tab.type === 'terminal') {
        if (typeof tab.terminal === 'string') {
          switchTab(tab.terminal)
          return
        }
        terminalDiagnosticsRef.current.tabSwitch('terminal', tab.id, true)
        triggerSelection()
        pendingSelectionRef.current = { kind: 'tab', tabId: tab.id }
        activeSessionTabTypeRef.current = 'terminal'
        setActiveSessionTabId(tab.id)
        const prev = activeHandleRef.current
        if (prev) {
          unsubscribeTerminal(prev)
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
          })
            .then(reportActivation)
            .catch(() => {})
        }
        return
      }

      triggerSelection()
      terminalDiagnosticsRef.current.tabSwitch(tab.type, tab.id, false)
      pendingSelectionRef.current = { kind: 'tab', tabId: tab.id }
      activeSessionTabTypeRef.current = tab.type
      setActiveSessionTabId(tab.id)
      const prev = activeHandleRef.current
      if (prev) {
        unsubscribeTerminal(prev)
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
        })
          .then(reportActivation)
          .catch(() => {})
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
    [
      activeSessionTabId,
      client,
      fileDocs,
      markdownDocs,
      readFileTab,
      readMarkdownTab,
      reportActivation,
      switchTab,
      unsubscribeTerminal,
      worktreeId
    ]
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
