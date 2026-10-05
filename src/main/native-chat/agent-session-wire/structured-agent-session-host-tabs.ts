import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
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
      logger: StructuredAgentSessionLogger
      store: {
        setSessionTabVisibility: (
          sessionId: string,
          visible: boolean,
          tabId?: string
        ) => Promise<void>
      }
    }
    restartResume: { dismiss: (sessionIds: readonly string[]) => Promise<number> }
  },
  sessionId: string,
  visible: boolean,
  tabId?: string
): Promise<void> {
  if (!visible) {
    void host.restartResume.dismiss([sessionId]).catch(() => {
      host.deps.logger.warn('forgetting recovery records on chat close failed', {
        scope: 'tab-close-recovery-dismiss',
        sessionId
      })
    })
  }
  return host.deps.store.setSessionTabVisibility(sessionId, visible, tabId)
}

/** Whether the chat still has its tab. A legacy store with no tab index cannot say, so yes. */
export function sessionTabListed(
  store: { getVisibleSessionTabIndex: () => { present: boolean; sessionIds: string[] } },
  sessionId: string
): boolean {
  const tabs = store.getVisibleSessionTabIndex()
  return !tabs.present || tabs.sessionIds.includes(sessionId)
}

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
}

/** Tabs from durable state alone: each requested id, once, in the order given, that has a record
 *  this host serves. Opens nothing: a chat whose history is unreadable keeps its tab and its read
 *  says why; one whose history is missing keeps its tab and reads empty. */
export function listPersistedSessionTabs(
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

type TabSessions = ReadonlyMap<string, { child?: unknown }>

/** The host's chat-tab surface; reads `host.deps` per call, so it sees the host's wrapped deps. */
export function createStructuredAgentSessionTabSurface(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0] & {
    deps: Parameters<typeof listPersistedSessionTabs>[0] & {
      store: Pick<
        AgentSessionRecordStore,
        'getVisibleSessionTabIndex' | 'getSessionTabId' | 'showSessionTabs'
      >
    }
  },
  sessions: TabSessions,
  forgetStatus: (sessionId: string) => void
) {
  return {
    /** From the record store and the given tab ids; opens no conversation. */
    listSessionTabs: (ids: readonly string[]) => listPersistedSessionTabs(host.deps, ids),
    getPersistedVisibleSessionTabIndex: () => host.deps.store.getVisibleSessionTabIndex(),
    getSessionTabId: (sessionId: string): string | null =>
      host.deps.store.getSessionTabId(sessionId),
    showSessionTabs: (sessionIds: readonly string[]) => host.deps.store.showSessionTabs(sessionIds),
    setSessionTabVisibility: async (
      sessionId: string,
      visible: boolean,
      tabId?: string
    ): Promise<void> => {
      await setStructuredAgentSessionTabVisibility(host, sessionId, visible, tabId)
      // The tab edge of the row's lifetime; the handle close is the other.
      if (!visible && !sessions.get(sessionId)?.child) {
        forgetStatus(sessionId)
      }
    }
  }
}
