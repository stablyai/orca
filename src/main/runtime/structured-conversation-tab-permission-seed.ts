import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionPermissionFact } from '../../shared/agent-chat-permission-mode'
import { storedAgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

/** Derive the first-frame picker from host intent without another options request. */
export function seedStructuredConversationTabPermissions(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  recordFor: (sessionId: string) => AgentSessionRecord | undefined,
  factFor?: (sessionId: string) => AgentSessionPermissionFact | undefined
): RuntimeMobileSessionTabsSnapshot {
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => {
      if (tab.type !== 'agent-session') {
        return tab
      }
      // The seed is optional: a failed read lists the tab without one.
      try {
        return seedTab(tab, snapshot.worktree, recordFor, factFor)
      } catch (error) {
        console.warn('[structured-chat] seeding a chat tab permission failed', tab.sessionId, error)
        return tab
      }
    })
  }
}

function seedTab(
  tab: RuntimeMobileSessionAgentTab,
  worktree: string,
  recordFor: (sessionId: string) => AgentSessionRecord | undefined,
  factFor?: (sessionId: string) => AgentSessionPermissionFact | undefined
): RuntimeMobileSessionAgentTab {
  const record = recordFor(tab.sessionId)
  if (record?.location.workspaceId !== worktree) {
    return tab
  }
  const fact = factFor?.(tab.sessionId)
  const mode = fact ? fact.mode : storedAgentChatPermissionMode(record.provider, record.options)
  return mode
    ? {
        ...tab,
        permissionSeed: {
          mode,
          fence: fact?.fence ?? record.lease.runtimeFence,
          ...(fact ? { revision: fact.revision } : {})
        }
      }
    : tab
}
