import type { GlobalSettings } from '../../shared/global-settings-types'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { ExternalConversationSeam } from './external-conversation-seam'
import type { SessionRows } from './external-conversation-session-capture'
import { fakeLinkStore } from './external-conversation.test-fixture'

/** A seam over fake records, receipts, workspace removals and hook session reports. */
export function harness(
  settings: Partial<GlobalSettings> = {},
  records = fakeLinkStore(),
  db = new OrchestrationDb(':memory:'),
  sessionRows: SessionRows = { getAgentStatusRowsForPane: () => [] }
) {
  const removed = new Set<(worktreeId: string) => void>()
  const sessionListeners = new Set<
    (sessions: readonly { paneKey: string; sessionId: string }[]) => void
  >()
  const seam = (): ExternalConversationSeam =>
    new ExternalConversationSeam({
      store: records.store,
      readSettings: () => settings,
      receiptDb: () => db,
      sessionRows,
      onWorkspaceRemoved: (listener) => {
        removed.add(listener)
        return () => removed.delete(listener)
      },
      onProviderSessionsChanged: (listener) => {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
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
    reportSessions
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
