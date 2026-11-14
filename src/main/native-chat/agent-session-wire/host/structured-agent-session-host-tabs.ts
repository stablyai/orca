import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import { seedSavedStructuredSessionTabs } from '../observations/structured-agent-session-saved-status'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
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
          capture?: (tabId: string | null) => void,
          commit?: (receipt: JournalOperationReceipt) => Promise<unknown>
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
  capture?: (tabId: string | null) => void,
  commit?: (receipt: JournalOperationReceipt) => Promise<unknown>
): Promise<void> {
  await (check || capture || commit
    ? host.deps.store.setSessionTabVisibility(sessionId, visible, tabId, check, capture, commit)
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
  delivery: Pick<
    StructuredAgentSessionClientDelivery,
    'forgetStatus' | 'publishStatus' | 'publishSavedStatusGroup'
  >,
  recover: (ids: readonly string[]) => Promise<void>,
  recoveryHider?: Parameters<typeof createRestartTabHider>[0]
) {
  const hideRecovery = recoveryHider ? createRestartTabHider(recoveryHider) : undefined
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
          delivery.publishSavedStatusGroup((publish) =>
            visit((record, markerAt) => {
              publish(record, markerAt)
            })
          ),
        recover
      ),
    getPersistedVisibleSessionTabIndex: () => host.deps.store.getVisibleSessionTabIndex(),
    getSessionTabId: (sessionId: string): string | null =>
      host.deps.store.getSessionTabId(sessionId),
    showSessionTabs: async (sessionIds: readonly string[]) => {
      const result = await host.deps.store.showSessionTabs(sessionIds)
      sessionIds.forEach(delivery.publishStatus)
      return result
    },
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
      const write = (commit?: (receipt: JournalOperationReceipt) => Promise<unknown>) =>
        setStructuredAgentSessionTabVisibility(
          host,
          sessionId,
          visible,
          tabId,
          options?.check,
          (id) => {
            actualId = id
            options?.capture?.(id)
          },
          commit
        )
      await (!visible && hideRecovery ? hideRecovery(sessionId, write) : write())
      if (!visible) {
        if (!options?.deferHiddenNotice) {
          notifyTabHidden(host, sessionId, actualId ?? undefined)
        }
      }
      delivery.publishStatus(sessionId)
      // Tab visibility and handle closure jointly determine status-row lifetime.
      if (!visible && !sessions.get(sessionId)?.child) {
        delivery.forgetStatus(sessionId)
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

export function createRestartTabHider(input: {
  serialize: <T>(id: string, apply: () => Promise<T>) => Promise<T>
  hasUnaccepted: (id: string) => boolean
  open: (id: string) => Promise<{
    journal: {
      appendStopEvent: (
        event: { reason: 'user-close' },
        fence: number,
        receipt: JournalOperationReceipt
      ) => Promise<unknown>
    }
  } | null>
  fence: (id: string) => number
}): (
  id: string,
  hide: (commit?: (receipt: JournalOperationReceipt) => Promise<unknown>) => Promise<void>
) => Promise<void> {
  return (id, hide) =>
    input.serialize(id, async () => {
      if (!input.hasUnaccepted(id)) {
        return hide()
      }
      const session = await input.open(id)
      if (!session) {
        return hide()
      }
      return hide((receipt) =>
        session.journal.appendStopEvent({ reason: 'user-close' }, input.fence(id), receipt)
      )
    })
}
