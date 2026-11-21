import type { OrchestrationDb } from '../orchestration-db'

// SPIKE, not for merge: edge listeners the shadow question reconcile subscribes to.
// Each fires after the commit that caused it (node:sqlite is synchronous, so a microtask runs after it).

/** E12: mail left these mailboxes (read or delivered). */
export const mailboxDrainListeners = new Set<(mailboxes: string[]) => void>()
/** E5: a dispatch or its worker changed state. */
export const dispatchTransitionListeners = new Set<(dispatchId: string) => void>()
/** E1: a chat's status was observed. */
export const structuredStateObservers = new Set<
  (observed: { sessionId: string; running: boolean; closed: boolean }) => void
>()

export function emitAfterCommit<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  if (listeners.size === 0) {
    return
  }
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(value)
      } catch (error) {
        console.warn('[question-shadow] edge listener failed', error)
      }
    }
  })
}

/** SPIKE: reads a chat's journal now: true while its turn runs, a send is owed or its goal continues
 *  (and no person is being asked); null when the chat isn't loaded. */
export const chatRunningReaders = new Set<(sessionId: string) => Promise<boolean | null>>()

/** E12/E6: mail in these messages' mailboxes was read, delivered, or ended its send. */
export function emitDrained(db: OrchestrationDb, ids: readonly string[]): void {
  if (mailboxDrainListeners.size === 0 || ids.length === 0) {
    return
  }
  const rows = db.db
    .prepare(
      `SELECT DISTINCT to_handle FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as { to_handle: string }[]
  emitAfterCommit(
    mailboxDrainListeners,
    rows.map((row) => row.to_handle)
  )
}

type ChatStatus = {
  latestRequest: { turnState: string | null } | null
  owesWork: boolean
  goalContinues?: boolean
  pendingPromptIds: readonly string[]
}

/** Design §1.3: running while its turn runs, a send is owed or its goal continues, with no prompt. */
export function chatRunning(state: ChatStatus): boolean {
  return (
    (state.latestRequest?.turnState === 'running' ||
      state.owesWork ||
      state.goalContinues === true) &&
    state.pendingPromptIds.length === 0
  )
}
