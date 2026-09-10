import type { MobileSessionTab, Terminal } from './mobile-session-route-types'
import type { MobileSessionContentCreateActionsModel } from './use-mobile-session-content-create-actions'

export function useMobileSessionCloseActions(scope: MobileSessionContentCreateActionsModel) {
  const {
    worktreeId,
    client,
    setTerminals,
    terminals,
    terminalsRef,
    setSessionTabs,
    sessionTabsRef,
    reconcileBufferedDraftsRef,
    closedTabTombstonesRef,
    clearTerminalLiveInputDefault,
    setActiveHandle,
    setActiveSessionTabId,
    activeSessionTabIdRef,
    selectedSessionTabIdRef,
    renameTarget,
    setRenameTarget,
    terminalRefs,
    initializedHandlesRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingActiveTerminalHandleRef,
    pendingBrowserFocusPageIdRef,
    scheduleDelayedAction,
    unsubscribeTerminal,
    subscribeToTerminal,
    fetchTerminals
  } = scope
  async function handleRenameTerminal(value: string) {
    if (!client || !renameTarget) {
      return
    }
    const target = renameTarget
    setRenameTarget(null)

    try {
      const title = value.trim()
      const response = await client.sendRequest('terminal.rename', {
        terminal: target.handle,
        title
      })
      if (response.ok) {
        setTerminals((prev) => {
          const next = prev.map((terminal) =>
            terminal.handle === target.handle
              ? { ...terminal, title: title || 'Terminal' }
              : terminal
          )
          terminalsRef.current = next
          return next
        })
        scheduleDelayedAction(() => void fetchTerminals(), 300)
      }
    } catch {
      // Rename failed — refresh will restore the server title.
    }
  }

  async function handleCloseTerminal(target: Terminal) {
    if (!client) {
      return
    }

    try {
      const response = await client.sendRequest('terminal.close', {
        terminal: target.handle
      })
      if (response.ok) {
        unsubscribeTerminal(target.handle)
        terminalRefs.current.delete(target.handle)
        initializedHandlesRef.current.delete(target.handle)
        clearTerminalLiveInputDefault(target.handle)
        const next = terminals.filter((terminal) => terminal.handle !== target.handle)
        setTerminals(next)
        terminalsRef.current = next
        if (activeHandleRef.current === target.handle) {
          const replacement = next[0] ?? null
          activeHandleRef.current = replacement?.handle ?? null
          pendingActiveTerminalHandleRef.current = replacement?.handle ?? null
          setActiveHandle(replacement?.handle ?? null)
          if (replacement) {
            subscribeToTerminal(replacement.handle)
          }
        }
      }
    } catch {
      // Close failed — keep the local tab list unchanged.
    }
  }

  async function handleCloseSessionTab(tab: MobileSessionTab) {
    if (!client) {
      return
    }
    try {
      const response = await client.sendRequest('session.tabs.close', {
        worktree: `id:${worktreeId}`,
        tabId: tab.id,
        // Why: a tapped tab close is explicit user intent; older hosts strip
        // the unknown field and keep their legacy behavior.
        reason: 'user'
      })
      if (response.ok) {
        const remainingTabs = sessionTabsRef.current.filter((candidate) => candidate.id !== tab.id)
        reconcileBufferedDraftsRef.current(sessionTabsRef.current, remainingTabs)
        if (tab.type === 'browser' && tab.browserPageId === pendingBrowserFocusPageIdRef.current) {
          pendingBrowserFocusPageIdRef.current = null
        }
        if (tab.type === 'terminal' && typeof tab.terminal === 'string') {
          const terminalHandle = tab.terminal
          unsubscribeTerminal(terminalHandle)
          terminalRefs.current.delete(terminalHandle)
          initializedHandlesRef.current.delete(terminalHandle)
          clearTerminalLiveInputDefault(terminalHandle)
        }
        sessionTabsRef.current = remainingTabs
        setSessionTabs(remainingTabs)
        // Why: tombstone the closed tab and rely on the snapshot, not a blind refetch that often re-added the not-yet-closed tab.
        closedTabTombstonesRef.current.set(tab.id, Date.now() + 10_000)
        // Why: bulk close re-activates the anchor before awaiting each close;
        // the render-synced ref sees that switch while this closure would not,
        // so comparing against the ref keeps the anchor from being nulled out.
        if (activeSessionTabIdRef.current === tab.id || remainingTabs.length === 0) {
          activeSessionTabTypeRef.current = null
          selectedSessionTabIdRef.current = null
          activeSessionTabIdRef.current = null
          setActiveSessionTabId(null)
          activeHandleRef.current = null
          setActiveHandle(null)
        }
      }
    } catch {
      // Close failed — keep the authoritative session snapshot visible.
    }
  }
  return {
    handleRenameTerminal,
    handleCloseTerminal,
    handleCloseSessionTab
  }
}

export type MobileSessionCloseActionsModel = MobileSessionContentCreateActionsModel &
  ReturnType<typeof useMobileSessionCloseActions>
