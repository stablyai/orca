import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

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

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
}

export function listStructuredAgentSessionTabs(
  sessions: ReadonlyMap<
    string,
    { params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] } }
  >
): StructuredAgentSessionTab[] {
  return [...sessions.entries()].map(([sessionId, session]) => ({
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider
  }))
}

type TabSessions = ReadonlyMap<
  string,
  {
    child?: unknown
    params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] }
  }
>

/** The host's chat-tab surface; reads `host.deps` per call, so it sees the host's wrapped deps. */
export function createStructuredAgentSessionTabSurface(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0] & {
    deps: {
      store: Pick<
        AgentSessionRecordStore,
        'getVisibleSessionTabIndex' | 'getSessionTabId' | 'showSessionTabs' | 'getRecord'
      >
    }
  },
  sessions: TabSessions,
  forgetStatus: (sessionId: string) => void
) {
  // Restored chats that could not be opened. Each keeps its tab, whose read says why.
  const unopened = new Set<string>()
  return {
    listSessionTabs: (): StructuredAgentSessionTab[] => [
      ...listStructuredAgentSessionTabs(sessions),
      ...[...unopened].flatMap((sessionId) => {
        const record = sessions.has(sessionId) ? null : host.deps.store.getRecord(sessionId)
        return record
          ? [{ sessionId, workspaceId: record.location.workspaceId, agent: record.provider }]
          : []
      })
    ],
    /** A restore target with a record whose open failed. */
    markUnopened: (sessionId: string): void => {
      unopened.add(sessionId)
    },
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
      if (!visible) {
        unopened.delete(sessionId)
      }
      // The tab edge of the row's lifetime; the handle close is the other.
      if (!visible && !sessions.get(sessionId)?.child) {
        forgetStatus(sessionId)
      }
    }
  }
}
