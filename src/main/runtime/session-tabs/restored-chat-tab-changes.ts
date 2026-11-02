import { chatTabChangesMatchingIndex } from '../structured-agent-session-tab-index-seed'
import { chatTabId, type ChatTabChange } from '../agent-session-tab-layout'
import { structuredSessionTabRetired } from '../structured-worker-custody'
import type { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

type ChatTabOpen = Extract<ChatTabChange, { open: unknown }>['open']

/** Chat-tab changes that make each worktree's saved tabs match the restored sessions. */
export function restoredChatTabChanges(
  savedTabsByWorktree: Parameters<typeof chatTabChangesMatchingIndex>[0],
  host: ReturnType<typeof getStructuredAgentSessionHost>,
  restored: readonly { workspaceId: string; sessionId: string; agent: ChatTabOpen['agent'] }[]
): Map<string, ChatTabChange[]> {
  return chatTabChangesMatchingIndex(
    savedTabsByWorktree,
    restored.map((session) => ({
      worktreeId: session.workspaceId,
      open: {
        sessionId: session.sessionId,
        agent: session.agent,
        tabId: chatTabId(session.sessionId)
      }
    })),
    // A chat a newer Orca wrote is only unreadable here, so it keeps its tab.
    (sessionId) =>
      !!host &&
      structuredSessionTabRetired(host, sessionId) &&
      !host.deps?.store?.isSessionUnreadable?.(sessionId)
  )
}
