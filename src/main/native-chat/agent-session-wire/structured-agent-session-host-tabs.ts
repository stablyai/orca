import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'

/**
 * Chat-tab visibility is the deletion funnel: every path that removes a chat as a user-facing
 * artifact — a closed tab, the close RPC, worker settlement, worktree removal — retires the
 * durable tab here, so the chat's restart offer and any failure record die with it. Advisory:
 * recovery bookkeeping must never gate closing a chat.
 */
export function setStructuredAgentSessionTabVisibility(
  host: {
    deps: {
      store: { setSessionTabVisibility: (sessionId: string, visible: boolean) => Promise<void> }
    }
    restartResume: { dismiss: (sessionIds: readonly string[]) => Promise<number> }
  },
  sessionId: string,
  visible: boolean
): Promise<void> {
  if (!visible) {
    void host.restartResume.dismiss([sessionId]).catch(() => {
      console.warn('[structured-agent-session] forgetting recovery records on chat close failed')
    })
  }
  return host.deps.store.setSessionTabVisibility(sessionId, visible)
}

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
}

/** Tab existence from durable state: every requested id with a record this host serves, whether
 *  or not its journal opens. A chat that cannot be read keeps its tab and explains itself there. */
export function listPersistedStructuredAgentSessionTabs(
  deps: {
    store: { getRecord: (sessionId: string) => AgentSessionRecord | null }
    adapter: Parameters<typeof adapterSupportsRecord>[0]
  },
  sessionIds: readonly string[]
): StructuredAgentSessionTab[] {
  const tabs = new Map<string, StructuredAgentSessionTab>()
  for (const sessionId of sessionIds) {
    const record = deps.store.getRecord(sessionId)
    if (!record || tabs.has(sessionId) || !adapterSupportsRecord(deps.adapter, record)) {
      continue
    }
    tabs.set(sessionId, {
      sessionId,
      workspaceId: record.location.workspaceId,
      agent: record.provider
    })
  }
  return [...tabs.values()]
}
