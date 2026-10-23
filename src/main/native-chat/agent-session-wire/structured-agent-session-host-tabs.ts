import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionAtRest } from './structured-agent-session-status-summary'

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
      onSessionTabHidden?: (sessionId: string) => void
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
  statuses: {
    forgetStatus: (sessionId: string) => void
    publishAtRest: (sessionId: string, rest: StructuredAgentSessionAtRest) => void
  }
) {
  // Restored chats, listed from their records: startup opens none of them, and one that cannot
  // open keeps its tab, whose read says why.
  const listed = new Set<string>()
  return {
    listSessionTabs: (): StructuredAgentSessionTab[] => [
      ...listStructuredAgentSessionTabs(sessions),
      ...[...listed].flatMap((sessionId) => {
        const record = sessions.has(sessionId) ? null : host.deps.store.getRecord(sessionId)
        return record
          ? [{ sessionId, workspaceId: record.location.workspaceId, agent: record.provider }]
          : []
      })
    ],
    /** A restore target with a record, and its row while nothing has opened it; one whose journal
     *  could not be read has none until a read says why. */
    list: (sessionId: string, rest: StructuredAgentSessionAtRest | null): void => {
      listed.add(sessionId)
      if (rest) {
        statuses.publishAtRest(sessionId, rest)
      }
    },
    getPersistedVisibleSessionTabIndex: () => host.deps.store.getVisibleSessionTabIndex(),
    getSessionTabId: (sessionId: string): string | null =>
      host.deps.store.getSessionTabId(sessionId),
    showSessionTabs: (sessionIds: readonly string[]) => host.deps.store.showSessionTabs(sessionIds),
    notifySessionTabHidden: (sessionId: string): void => notifyTabHidden(host, sessionId),
    setSessionTabVisibility: async (
      sessionId: string,
      visible: boolean,
      tabId?: string,
      /** A close that may still put the tab back sends the hidden notice once it settles. */
      options?: { deferHiddenNotice?: boolean }
    ): Promise<void> => {
      await setStructuredAgentSessionTabVisibility(host, sessionId, visible, tabId)
      if (!visible) {
        listed.delete(sessionId)
        if (!options?.deferHiddenNotice) {
          notifyTabHidden(host, sessionId)
        }
      }
      // The tab edge of the row's lifetime; the handle close is the other.
      if (!visible && !sessions.get(sessionId)?.child) {
        statuses.forgetStatus(sessionId)
      }
    }
  }
}

function notifyTabHidden(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0],
  sessionId: string
): void {
  try {
    host.deps.onSessionTabHidden?.(sessionId)
  } catch (error) {
    // Bookkeeping never gates closing a chat.
    host.deps.logger.warn('a chat tab close listener failed', {
      scope: 'tab-hidden-listener',
      sessionId,
      error
    })
  }
}
