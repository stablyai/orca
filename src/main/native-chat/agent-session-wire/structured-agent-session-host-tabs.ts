import {
  seedSavedStructuredSessionTabs,
  type SavedStructuredStatusGroup
} from './structured-agent-session-saved-status'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** Retire durable tabs/restart offers together; advisory recovery bookkeeping must never block chat close. */
export async function setStructuredAgentSessionTabVisibility(
  host: {
    deps: {
      logger: StructuredAgentSessionLogger
      store: {
        setSessionTabVisibility: (
          sessionId: string,
          visible: boolean,
          tabId?: string,
          check?: () => void,
          capture?: (tabId: string | null) => void
        ) => Promise<void>
      }
      onSessionTabHidden?: (sessionId: string, tabId?: string) => void
    }
    restartResume: { dismiss: (sessionIds: readonly string[]) => Promise<number> }
  },
  sessionId: string,
  visible: boolean,
  tabId?: string,
  check?: () => void,
  capture?: (tabId: string | null) => void
): Promise<void> {
  await (check || capture
    ? host.deps.store.setSessionTabVisibility(sessionId, visible, tabId, check, capture)
    : host.deps.store.setSessionTabVisibility(sessionId, visible, tabId))
  if (!visible) {
    void host.restartResume.dismiss([sessionId]).catch(() => {
      host.deps.logger.warn('forgetting recovery records on chat close failed', {
        scope: 'tab-close-recovery-dismiss',
        sessionId
      })
    })
  }
}

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
}

type TabSessions = ReadonlyMap<
  string,
  {
    child?: unknown
    params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] }
  }
>

export function createStructuredAgentSessionTabSurface(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0] & {
    deps: Pick<StructuredAgentSessionHostDeps, 'recoveryCapsule' | 'now'> & {
      store: Pick<
        AgentSessionRecordStore,
        | 'getVisibleSessionTabIndex'
        | 'getSessionTabId'
        | 'showSessionTabs'
        | 'getConversation'
        | 'listConversations'
        | 'listVisibleSessionIds'
        | 'isSessionTabVisible'
      >
    }
  },
  sessions: TabSessions,
  forgetStatus: (sessionId: string) => void,
  publishSavedStatusGroup: SavedStructuredStatusGroup,
  recover: (ids: readonly string[]) => Promise<void>
) {
  return {
    listSessionTabs: (): StructuredAgentSessionTab[] =>
      host.deps.store.listVisibleSessionIds().flatMap((sessionId) => {
        const record = host.deps.store.getConversation(sessionId)
        return record
          ? [{ sessionId, workspaceId: record.location.workspaceId, agent: record.provider }]
          : []
      }),
    isSessionTabVisible: (id: string) => host.deps.store.isSessionTabVisible(id),
    seedSessionTabs: (ids?: readonly string[]): Promise<void> =>
      seedSavedStructuredSessionTabs(
        host.deps,
        ids,
        (visit) =>
          publishSavedStatusGroup((publish) =>
            visit((record, markerAt) => {
              publish(record, markerAt)
            })
          ),
        recover
      ),
    getPersistedVisibleSessionTabIndex: () => host.deps.store.getVisibleSessionTabIndex(),
    getSessionTabId: (sessionId: string): string | null =>
      host.deps.store.getSessionTabId(sessionId),
    showSessionTabs: (sessionIds: readonly string[]) => host.deps.store.showSessionTabs(sessionIds),
    notifySessionTabHidden: (sessionId: string, tabId?: string): void =>
      notifyTabHidden(host, sessionId, tabId),
    setSessionTabVisibility: async (
      sessionId: string,
      visible: boolean,
      tabId?: string,
      /** Defer hidden notices while a failed close could restore visibility. */
      options?: {
        deferHiddenNotice?: boolean
        check?: () => void
        capture?: (tabId: string | null) => void
      }
    ): Promise<void> => {
      let actualId: string | null = null
      await setStructuredAgentSessionTabVisibility(
        host,
        sessionId,
        visible,
        tabId,
        options?.check,
        (id) => {
          actualId = id
          options?.capture?.(id)
        }
      )
      if (!visible) {
        if (!options?.deferHiddenNotice) {
          notifyTabHidden(host, sessionId, actualId ?? undefined)
        }
      }
      // Tab visibility and handle closure jointly determine status-row lifetime.
      if (!visible && !sessions.get(sessionId)?.child) {
        forgetStatus(sessionId)
      }
    }
  }
}

function notifyTabHidden(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0],
  sessionId: string,
  tabId?: string
): void {
  try {
    host.deps.onSessionTabHidden?.(sessionId, tabId)
  } catch (error) {
    host.deps.logger.warn('a chat tab close listener failed', {
      scope: 'tab-hidden-listener',
      sessionId,
      error
    })
  }
}
