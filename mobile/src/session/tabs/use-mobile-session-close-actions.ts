import {
  pendingSelectionTabId,
  withoutPendingHandle,
  withoutPendingTabId
} from './pending-session-selection'
import { sessionTabClose } from './mobile-session-tab-write-operations'
import {
  sessionTerminalClose,
  sessionTerminalRename
} from '../../terminal/session/mobile-session-terminal-operations'
import type { MobileSessionTab } from './mobile-session-tabs'
import type { Terminal } from '../../terminal/session/mobile-terminal-model'
import type { MobileSessionContentCreateActionsModel } from '../use-mobile-session-content-create-actions'
import { mobileNativeChatScopeKey } from '../native-chat/mobile-native-chat-scope-key'
import { closeMobileNativeChatTabDraft } from '../native-chat/composer/mobile-native-chat-draft-store'
import {
  defineHostMutation,
  useHostMutation,
  type HostMutationPhase
} from '../../query/host-mutation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { translate } from '../../i18n/mobile-i18n'

async function sendTerminalRename(
  client: RpcClient,
  vars: { terminal: string; title: string }
): Promise<void> {
  const reply = await sessionTerminalRename.request(client, vars)
  if (!reply.ok) {
    throw new Error(reply.error.message)
  }
}

const terminalRename = defineHostMutation({
  offline: 'draft',
  send: sendTerminalRename,
  // Renaming is idempotent, so a lost reply is settled by sending the same title again.
  confirm: sendTerminalRename
})

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
    forgetLastSessionTab,
    closedTabTombstonesRef,
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
    fetchTerminals,
    showToast
  } = scope
  const terminalRenameWrite = useHostMutation(terminalRename, { hostId, client })
  // A refused or lost close keeps the tab, so say so rather than leave the tap unanswered.
  function showCloseFailed(code?: string) {
    showToast(
      code === 'runtime_unavailable'
        ? translate(
            'session.useCloseActions.closeFailedDesktopNotReady',
            "Couldn't close the tab. Orca on your computer is still loading. Try again in a moment."
          )
        : translate('session.useCloseActions.closeFailed', "Couldn't close the tab. Try again."),
      2400
    )
  }
  // Throws on refusal so the sheet keeps the typed name and offers Retry.
  async function handleRenameTerminal(
    value: string,
    onPhase?: (phase: HostMutationPhase) => void
  ): Promise<void> {
    const target = renameTarget
    if (!target) {
      return
    }
    const title = value.trim()
    await terminalRenameWrite.mutate({ terminal: target.handle, title }, { onPhase })
    setTerminals((prev) => {
      const next = prev.map((terminal) =>
        terminal.handle === target.handle ? { ...terminal, title: title || 'Terminal' } : terminal
      )
      terminalsRef.current = next
      return next
    })
    scheduleDelayedAction(() => void fetchTerminals(), 300)
    // A sheet reopened for another terminal while this one was in flight stays open.
    setRenameTarget((current) => (current === target ? null : current))
  }

  async function handleCloseTerminal(target: Terminal) {
    if (!client) {
      return
    }

    try {
      const reply = await sessionTerminalClose.request(client, { terminal: target.handle })
      const response = sessionTerminalClose.interpret(reply)
      if (!response.accepted) {
        showCloseFailed(reply.ok ? undefined : reply.error.code)
      } else {
        unsubscribeTerminal(target.handle)
        terminalRefs.current.delete(target.handle)
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
    } catch {
      showCloseFailed()
    }
  }

  async function handleCloseSessionTab(tab: MobileSessionTab) {
    if (!client) {
      return
    }
    try {
      const reply = await sessionTabClose.request(client, {
        worktree: `id:${worktreeId}`,
        tabId: tab.id,
        // Why: a tapped tab close is explicit user intent; older hosts strip
        // the unknown field and keep their legacy behavior.
        reason: 'user'
      })
      const response = sessionTabClose.interpret(reply)
      if (!response.accepted || response.value.refused) {
        showCloseFailed(reply.ok ? undefined : reply.error.code)
      } else {
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
        const remainingTabs = sessionTabsRef.current.filter((candidate) => candidate.id !== tab.id)
        if (tab.type === 'browser' && tab.browserPageId === pendingBrowserFocusPageIdRef.current) {
          pendingBrowserFocusPageIdRef.current = null
        }
        if (tab.type === 'terminal' && typeof tab.terminal === 'string') {
          const terminalHandle = tab.terminal
          unsubscribeTerminal(terminalHandle)
          terminalRefs.current.delete(terminalHandle)
        }
        sessionTabsRef.current = remainingTabs
        setSessionTabs(remainingTabs)
        forgetLastSessionTab(tab.id)
        // Tombstone closed tabs until snapshots confirm them; immediate refetch can resurrect a pending close.
        closedTabTombstonesRef.current.set(tab.id, Date.now() + 10_000)
        if (selectedSessionTabIdRef.current === tab.id) {
          selectedSessionTabIdRef.current =
            remainingTabs.find((candidate) => candidate.id === activeSessionTabIdRef.current)?.id ??
            null
        }
        if (pendingSelectionTabId(pendingSelectionRef.current) === tab.id) {
          pendingSelectionRef.current = withoutPendingTabId(pendingSelectionRef.current)
        }
        // Read active identity live: bulk close can reactivate its anchor while an older close closure still names another tab.
        if (activeSessionTabIdRef.current === tab.id) {
          activeSessionTabTypeRef.current = null
          activeSessionTabIdRef.current = null
          setActiveSessionTabId(null)
          activeHandleRef.current = null
          setActiveHandle(null)
        }
      }
    } catch {
      showCloseFailed()
    }
  }
  return {
    handleRenameTerminal,
    terminalRenameWrite,
    handleCloseTerminal,
    handleCloseSessionTab
  }
}

export type MobileSessionCloseActionsModel = MobileSessionContentCreateActionsModel &
  ReturnType<typeof useMobileSessionCloseActions>
