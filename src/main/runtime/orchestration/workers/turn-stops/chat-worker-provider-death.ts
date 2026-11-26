import type { StructuredAgentSessionIdleDeath } from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'
import { observeWorker } from './worker-presence-report'
import { isWorkerStartOrStopUndecided } from '../lifecycle/worker-exit-observation'

/** A chat worker's provider died with no turn running: nothing else tells its coordinator. */
export function reportChatWorkerProviderDeath(
  death: StructuredAgentSessionIdleDeath,
  deps: WorkerTurnStopReportDeps
): void {
  try {
    const db = deps.getDb()
    if (!db) {
      return
    }
    for (const { dispatch, from } of chatWorkerDispatches(death.sessionId, db)) {
      if (isWorkerStartOrStopUndecided(db.getWorkerDispatch(dispatch.id)?.state)) {
        continue
      }
      // Mail starts the chat again, and its next working edge makes a later death news again.
      observeWorker(
        db,
        { kind: 'local', dispatch },
        {
          presence: 'gone',
          fence: `${death.sessionId}:${death.fence}`,
          legacyStopKey: `exit:${death.sessionId}:${death.fence}`,
          gone: {
            from,
            reason: 'exited',
            ...(death.reason ? { cause: death.reason } : {}),
            restartsOnMail: true,
            lastOutput: undefined
          }
        },
        deps
      )
    }
  } catch (error) {
    console.warn('[orchestration] chat worker exit report failed', death.sessionId, error)
  }
}
