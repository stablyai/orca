import { useCallback } from 'react'
import { triggerError } from '../platform/haptics'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import {
  getMobileAgentSessionTerminalActions,
  type MobileAgentSessionTerminalOpen
} from './mobile-agent-session-terminal-actions'
import {
  AGENT_SESSION_TERMINAL_OPEN_FAILED,
  openMobileAgentSessionInTerminal
} from './mobile-agent-session-terminal-open-run'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileProviderSessions } from './mobile-structured-provider-session'

/**
 * The structured Chat tab's "Open in Terminal" item, with the write behind it. A failed write is
 * reported on the route's toast, never swallowed: the host names the cause, and a conversation
 * another chat holds is a refusal this surface has to word.
 */
export function useMobileAgentSessionTerminalAction(args: {
  client: RpcClient | null
  worktreeId: string
  /** What each chat's history read named; a tab it has no entry for offers nothing. */
  chatProviderSessions: MobileProviderSessions
  showToast: (message: string, durationMs?: number) => void
  /** Closes the sheet the item was pressed on. */
  onDismiss: () => void
}): (tab: { sessionId: string; agent: string } | null) => ActionSheetAction[] {
  const { chatProviderSessions, client, onDismiss, showToast, worktreeId } = args
  const open = useCallback(
    (target: MobileAgentSessionTerminalOpen) => {
      onDismiss()
      if (!client) {
        triggerError()
        showToast(AGENT_SESSION_TERMINAL_OPEN_FAILED, 1800)
        return
      }
      void openMobileAgentSessionInTerminal(client, { worktreeId, ...target }).catch(
        (error: unknown) => {
          triggerError()
          showToast(refusedRpcMessageOrFallback(error, AGENT_SESSION_TERMINAL_OPEN_FAILED), 1800)
        }
      )
    },
    [client, onDismiss, showToast, worktreeId]
  )
  return useCallback(
    (tab: { sessionId: string; agent: string } | null): ActionSheetAction[] =>
      getMobileAgentSessionTerminalActions({
        tab,
        providerSession: tab ? (chatProviderSessions.get(tab.sessionId) ?? null) : null,
        onOpen: open
      }),
    [chatProviderSessions, open]
  )
}
