import type {
  StructuredAgentSessionIdleDeath,
  StructuredAgentSessionPersonClose
} from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
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

/** A person closed a running chat worker: the close stops it as worker-stop would, and its
 *  coordinator hears who closed it, since the worker never reports for itself. */
export function reportChatWorkerClosedByPerson(
  closed: StructuredAgentSessionPersonClose,
  runtimeEpoch: string,
  deps: WorkerTurnStopReportDeps
): void {
  try {
    const db = deps.getDb()
    if (!db) {
      return
    }
    for (const { dispatch, from } of chatWorkerDispatches(closed.sessionId, db)) {
      if (isWorkerStartOrStopUndecided(db.getWorkerDispatch(dispatch.id)?.state)) {
        continue
      }
      observeWorker(
        db,
        { kind: 'local', dispatch },
        {
          presence: 'gone',
          fence: `closed:${closed.sessionId}:${closed.fence}`,
          legacyStopKey: `closed:${closed.sessionId}:${closed.fence}`,
          gone: {
            from,
            reason: 'exited',
            closedBy: closed.closedBy ?? 'a person',
            lastOutput: undefined
          },
          settle: () => {
            // A worker the user keeps open refuses the stop; its coordinator still hears of the close.
            try {
              if (db.beginWorkerStop(dispatch.id, runtimeEpoch).disposition !== 'stopping') {
                return undefined
              }
              db.settleWorkerStop(dispatch.id)
              return 'stopped'
            } catch (error) {
              console.warn(
                '[orchestration] settling a closed chat worker failed',
                dispatch.id,
                error
              )
              return undefined
            }
          }
        },
        deps
      )
    }
  } catch (error) {
    console.warn('[orchestration] chat worker close report failed', closed.sessionId, error)
  }
}
