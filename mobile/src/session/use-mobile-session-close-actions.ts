import { pendingSelectionTabId, withoutPendingHandle } from './pending-session-selection'
import {
  sessionTabClose,
  sessionTerminalClose,
  sessionTerminalRename
} from './mobile-session-write-operations'
import type { MobileSessionTab, Terminal } from './mobile-session-route-types'
import { readAllRecentSessionCardsSync, removeRecentSessionCard } from './recent-session-cards'
import type { MobileSessionContentCreateActionsModel } from './use-mobile-session-content-create-actions'
import { mobileNativeChatScopeKey } from './native-chat/mobile-native-chat-scope-key'
import { closeMobileNativeChatTabDraft } from './native-chat/composer/mobile-native-chat-draft-store'

function pickReplacementSessionTab(args: {
  hostId: string | undefined
  worktreeId: string | undefined
  remainingTabs: readonly MobileSessionTab[]
  closedIndex: number
}): MobileSessionTab {
  const { hostId, worktreeId, remainingTabs, closedIndex } = args
  if (hostId && worktreeId) {
    const recentInWorktree = readAllRecentSessionCardsSync()
      .filter((card) => card.hostId === hostId && card.worktreeId === worktreeId)
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    for (const card of recentInWorktree) {
      const matched = remainingTabs.find(
        (candidate) =>
          candidate.id === card.tabId ||
          (card.terminalHandle !== undefined &&
            candidate.type === 'terminal' &&
            candidate.terminal === card.terminalHandle)
      )
      if (matched) {
        return matched
      }
    }
  }
  const activeTab = remainingTabs.find((candidate) => candidate.isActive)
  if (activeTab) {
    return activeTab
  }
  if (closedIndex >= 0) {
    return remainingTabs[closedIndex] ?? remainingTabs[closedIndex - 1] ?? remainingTabs[0]
  }
  return remainingTabs[0]
}

export function useMobileSessionCloseActions(scope: MobileSessionContentCreateActionsModel) {
  const {
    hostId,
    worktreeId,
    client,
    setTerminals,
    terminalsRef,
    setSessionTabs,
    setFileDocs,
    setMarkdownDocs,
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
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
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
      const response = sessionTerminalRename.interpret(
        await sessionTerminalRename.request(client, { terminal: target.handle, title })
      )
      if (response.accepted) {
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
    } catch {}
  }

  async function handleCloseTerminal(target: Terminal) {
    if (!client) {
      return
    }

    try {
      const response = sessionTerminalClose.interpret(
        await sessionTerminalClose.request(client, { terminal: target.handle })
      )
      if (response.accepted) {
        if (hostId && worktreeId) {
          removeRecentSessionCard(hostId, worktreeId, undefined, target.handle)
        }
        unsubscribeTerminal(target.handle)
        terminalRefs.current.delete(target.handle)
        clearTerminalLiveInputDefault(target.handle)
        const next = terminalsRef.current.filter((terminal) => terminal.handle !== target.handle)
        terminalsRef.current = next
        setTerminals(next)
        if (activeHandleRef.current === target.handle) {
          const replacement = next[0] ?? null
          activeHandleRef.current = replacement?.handle ?? null
          pendingSelectionRef.current = replacement
            ? {
                kind: 'terminal',
                handle: replacement.handle,
                tabId: pendingSelectionTabId(pendingSelectionRef.current)
              }
            : withoutPendingHandle(pendingSelectionRef.current)
          setActiveHandle(replacement?.handle ?? null)
          if (replacement) {
            subscribeToTerminal(replacement.handle)
          }
        }
      }
    } catch {}
  }

  async function handleCloseSessionTab(tab: MobileSessionTab) {
    if (!client) {
      return
    }
    try {
      const response = sessionTabClose.interpret(
        await sessionTabClose.request(client, {
          worktree: `id:${worktreeId}`,
          tabId: tab.id,
          // Why: a tapped tab close is explicit user intent; older hosts strip
          // the unknown field and keep their legacy behavior.
          reason: 'user'
        })
      )
      if (response.accepted && !response.value.refused) {
        if (hostId && worktreeId) {
          removeRecentSessionCard(
            hostId,
            worktreeId,
            tab.id,
            tab.type === 'terminal' ? tab.terminal : undefined
          )
        }
        const chatScope = mobileNativeChatScopeKey(hostId, worktreeId, tab.id)
        if (chatScope && response.value.retirementConfirmed) {
          closeMobileNativeChatTabDraft(chatScope)
        }
        if (tab.type === 'markdown') {
          setMarkdownDocs((prev) => {
            const doc = prev.get(tab.id)
            if (!doc || (doc.status === 'ready' && doc.isDirty)) {
              return prev
            }
            const next = new Map(prev)
            next.delete(tab.id)
            return next
          })
        }
        if (tab.type === 'file') {
          setFileDocs((prev) => {
            if (!prev.has(tab.id)) {
              return prev
            }
            const next = new Map(prev)
            next.delete(tab.id)
            return next
          })
        }
        const previousTabs = sessionTabsRef.current
        const closedIndex = previousTabs.findIndex((candidate) => candidate.id === tab.id)
        let remainingTabs = previousTabs.filter((candidate) => candidate.id !== tab.id)
        reconcileBufferedDraftsRef.current(previousTabs, remainingTabs)
        if (tab.type === 'browser' && tab.browserPageId === pendingBrowserFocusPageIdRef.current) {
          pendingBrowserFocusPageIdRef.current = null
        }
        if (tab.type === 'terminal' && typeof tab.terminal === 'string') {
          const terminalHandle = tab.terminal
          unsubscribeTerminal(terminalHandle)
          terminalRefs.current.delete(terminalHandle)
          clearTerminalLiveInputDefault(terminalHandle)
        }
        sessionTabsRef.current = remainingTabs
        setSessionTabs(remainingTabs)
        // Why: tombstone the closed tab and rely on the snapshot, not a blind refetch that often re-added the not-yet-closed tab.
        // Tombstone closed tabs until snapshots confirm them; immediate refetch can resurrect a pending close.
        closedTabTombstonesRef.current.set(tab.id, Date.now() + 10_000)
        // Why: bulk close re-activates the anchor before awaiting each close;
        // the render-synced ref sees that switch while this closure would not,
        // so comparing against the ref keeps the anchor from being nulled out.
        // Read active identity live: bulk close can reactivate its anchor while an older close closure still names another tab.
        if (remainingTabs.length === 0) {
          activeSessionTabTypeRef.current = null
          selectedSessionTabIdRef.current = null
          activeSessionTabIdRef.current = null
          setActiveSessionTabId(null)
          activeHandleRef.current = null
          setActiveHandle(null)
        } else if (activeSessionTabIdRef.current === tab.id) {
          const replacement = pickReplacementSessionTab({
            hostId,
            worktreeId,
            remainingTabs,
            closedIndex
          })
          remainingTabs = remainingTabs.map((candidate) =>
            candidate.isActive === (candidate.id === replacement.id)
              ? candidate
              : { ...candidate, isActive: candidate.id === replacement.id }
          )
          sessionTabsRef.current = remainingTabs
          setSessionTabs(remainingTabs)
          activeSessionTabTypeRef.current = replacement.type
          selectedSessionTabIdRef.current = replacement.id
          activeSessionTabIdRef.current = replacement.id
          setActiveSessionTabId(replacement.id)
          if (replacement.type === 'terminal' && typeof replacement.terminal === 'string') {
            activeHandleRef.current = replacement.terminal
            if (pendingSelectionRef) {
              pendingSelectionRef.current = {
                kind: 'terminal',
                handle: replacement.terminal,
                tabId: replacement.id
              }
            }
            setActiveHandle(replacement.terminal)
            subscribeToTerminal(replacement.terminal)
          } else {
            if (pendingSelectionRef) {
              pendingSelectionRef.current = {
                kind: 'tab',
                tabId: replacement.id
              }
            }
            activeHandleRef.current = null
            setActiveHandle(null)
          }
        } else {
          sessionTabsRef.current = remainingTabs
          setSessionTabs(remainingTabs)
        }
      }
    } catch {}
  }
  return {
    handleRenameTerminal,
    handleCloseTerminal,
    handleCloseSessionTab
  }
}

export type MobileSessionCloseActionsModel = MobileSessionContentCreateActionsModel &
  ReturnType<typeof useMobileSessionCloseActions>
