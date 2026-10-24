import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { StatusRowMutationListener } from '../agent-hooks/server/server-types'
import { TerminalAgentPhonePush } from '../runtime/terminal-agent-phone-push'
import type { MobileNotificationDispatchEvent } from '../runtime/runtime-mobile-notification-controller'
import type { LiveNotificationRetirement } from '../../shared/notification-settings-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { DeliveryReceipts } from './external-conversation-delivery-receipts'
import { ExternalConversationSeam } from './external-conversation-seam'
import type { SessionRows } from './external-conversation-session-capture'
import { fakeLinkStore } from './external-conversation.test-fixture'

export function harness(
  settings: Partial<GlobalSettings> = {},
  records = fakeLinkStore(),
  db = new OrchestrationDb(':memory:'),
  sessionRows: SessionRows = { getAgentStatusRowsForPane: () => [] }
) {
  const removed = new Set<(worktreeId: string) => void>()
  const hookRows = new Map<string, AgentStatusIpcPayload>()
  const paneListeners = new Set<(change: AgentPaneChange) => void>()
  const sessionListeners = new Set<
    (sessions: readonly { paneKey: string; sessionId: string }[]) => void
  >()
  const seam = (): ExternalConversationSeam =>
    new ExternalConversationSeam({
      store: records.store,
      readSettings: () => settings,
      receipts: new DeliveryReceipts(() => db),
      sessionRows,
      onWorkspaceRemoved: (listener) => {
        removed.add(listener)
        return () => removed.delete(listener)
      },
      onProviderSessionsChanged: (listener) => {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
      readHookRow: (paneKey) => hookRows.get(paneKey) ?? null,
      onAgentPaneChange: (listener) => {
        paneListeners.add(listener)
        return () => paneListeners.delete(listener)
      }
    })
  const reportSessions = (sessions: { paneKey: string; sessionId: string }[]): void =>
    sessionListeners.forEach((listener) => listener(sessions))
  const removeWorkspace = (worktreeId: string): void =>
    removed.forEach((listener) => listener(worktreeId))
  return {
    ...records,
    seam: seam(),
    restart: seam,
    db,
    removed,
    removeWorkspace,
    sessionListeners,
    reportSessions,
    /** The hook store's newest row per pane, as `readHookRow` reads it. */
    hookRows,
    paneListeners,
    paneChange: (change: AgentPaneChange): void =>
      paneListeners.forEach((listener) => listener(change))
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Real detector ordering over the fixture's host rows, with the actual independent phone owner. */
export function terminalConsumers(h: Pick<ReturnType<typeof harness>, 'hookRows' | 'paneChange'>) {
  const mutations = new Set<StatusRowMutationListener>()
  const changes: AgentPaneChange[] = []
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: () => undefined,
    subscribeToPtyExit: () => () => {},
    now: Date.now
  })
  const alerts: MobileNotificationDispatchEvent[] = []
  const retirements: LiveNotificationRetirement[][] = []
  const policy = { hasWindow: false }
  const phone = new TerminalAgentPhonePush({
    hasWindow: () => policy.hasWindow,
    readNotificationSettings: () => undefined,
    readWorkspaceLabels: () => ({}),
    isWorkspaceMuted: () => false,
    readHookRow: (paneKey) => h.hookRows.get(paneKey) ?? null,
    dispatch: (event) => alerts.push(event),
    retire: (items) => retirements.push(items),
    recordAnnounced: () => {},
    now: Date.now
  })
  const releasePhone = detector.subscribe((change) => phone.observe(change))
  const releaseChanges = detector.subscribe((change) => {
    changes.push(change)
    h.paneChange(change)
  })
  const detach = detector.attach({
    getStatusSnapshot: () => [...h.hookRows.values()],
    getStatusSnapshotForPane: (paneKey) => {
      const row = h.hookRows.get(paneKey)
      return row ? [row] : []
    },
    subscribeStatusRowMutations: (listener) => {
      mutations.add(listener)
      return () => mutations.delete(listener)
    }
  })
  return {
    phone,
    detector,
    changes,
    alerts,
    retirements,
    policy,
    report: (row: AgentStatusIpcPayload): void => {
      const before = h.hookRows.get(row.paneKey) ?? null
      h.hookRows.set(row.paneKey, row)
      mutations.forEach((listener) => listener({ before, after: row }))
    },
    dispose: (): void => {
      detach()
      releasePhone()
      releaseChanges()
      phone.dispose()
    }
  }
}
