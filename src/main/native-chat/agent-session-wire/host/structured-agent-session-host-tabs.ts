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
    deps: Pick<StructuredAgentSessionHostDeps, 'recoveryCapsule' | 'now' | 'journalDatabase'> & {
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
  recover: (ids: readonly string[]) => Promise<void>
) {
  const savedFailure = async (sessionId: string) => {
    const record = host.deps.store.getConversation(sessionId)
    if (!record || sessions.has(sessionId)) {
      return null
    }
    try {
      const result = await host.deps.journalDatabase.readers.point({
        sessionId,
        operation: {
          kind: 'queue',
          operation: { kind: 'held-delivery', facts: { reopenFloor: null } }
        }
      })
      return result.kind === 'queue' &&
        result.result.kind === 'held-delivery' &&
        result.result.delivery
        ? { record, delivery: result.result.delivery }
        : null
    } catch {
      return null
    }
  }
  const publishFailures = (entries: Awaited<ReturnType<typeof savedFailure>>[]) => {
    delivery.publishSavedStatusGroup((publish) => {
      for (const entry of entries) {
        if (entry) {
          publish(entry.record, undefined, entry.delivery)
        }
      }
    })
  }
  let dispose: (() => void) | undefined
  const watchConversions = () => {
    if (dispose) {
      return
    }
    dispose = host.deps.journalDatabase.watchConverted((sessionId) => {
      void savedFailure(sessionId)
        .then((entry) => publishFailures([entry]))
        .catch((error: unknown) =>
          host.deps.logger.warn('publishing saved worker failure failed', {
            scope: 'saved-worker-failure',
            sessionId,
            error
          })
        )
    })
  }
  return {
    dispose: () => {
      dispose?.()
      dispose = undefined
    },
    listSessionTabs: (): StructuredAgentSessionTab[] =>
      host.deps.store.listVisibleSessionIds().flatMap((sessionId) => {
        const record = host.deps.store.getConversation(sessionId)
        return record
          ? [{ sessionId, workspaceId: record.location.workspaceId, agent: record.provider }]
          : []
      }),
    isSessionTabVisible: (id: string) => host.deps.store.isSessionTabVisible(id),
    seedSessionTabs: async (ids?: readonly string[]): Promise<void> => {
      watchConversions()
      const records = host.deps.store.listConversations()
      for (let offset = 0; offset < records.length; offset += 32) {
        publishFailures(
          await Promise.all(
            records.slice(offset, offset + 32).map((record) => savedFailure(record.sessionId))
          )
        )
      }
      await seedSavedStructuredSessionTabs(
        host.deps,
        ids,
        (visit) =>
          delivery.publishSavedStatusGroup((publish) =>
            visit((record, markerAt) => {
              publish(record, markerAt)
            })
          ),
        recover
      )
    },
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
