import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'

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

/** Tabs from saved state alone: each given id, once and in order, that has a record and a history
 *  to read. Opens nothing; a chat that cannot open keeps its tab, and its read says why. */
export function listSavedSessionTabs(
  deps: {
    store: Pick<AgentSessionRecordStore, 'getRecord'>
    journalDatabase: { db: Parameters<typeof readJournalSessionEpoch>[0] }
  },
  sessionIds: readonly string[]
): StructuredAgentSessionTab[] {
  const tabs = new Map<string, StructuredAgentSessionTab>()
  for (const sessionId of sessionIds) {
    const record = tabs.has(sessionId) ? null : deps.store.getRecord(sessionId)
    // One never written stays unlisted rather than founding an empty history.
    if (record && readJournalSessionEpoch(deps.journalDatabase.db, sessionId) !== null) {
      tabs.set(sessionId, {
        sessionId,
        workspaceId: record.location.workspaceId,
        agent: record.provider
      })
    }
  }
  return [...tabs.values()]
}

type TabSessions = ReadonlyMap<string, { child?: unknown }>

/** The host's chat-tab surface; reads `host.deps` per call, so it sees the host's wrapped deps. */
export function createStructuredAgentSessionTabSurface(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0] & {
    deps: Parameters<typeof listSavedSessionTabs>[0] & {
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
    listSessionTabs: (sessionIds: readonly string[]) => listSavedSessionTabs(host.deps, sessionIds),
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
      if (!visible && !options?.deferHiddenNotice) {
        notifyTabHidden(host, sessionId)
      }
      // The tab edge of the row's lifetime; the handle close is the other.
      if (!visible && !sessions.get(sessionId)?.child) {
        forgetStatus(sessionId)
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
