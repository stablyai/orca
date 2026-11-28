import type {
  StructuredAgentSessionIdleDeath,
  StructuredAgentSessionPersonClose
} from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'
import { observeWorker } from './worker-presence-report'
import {
  isWorkerStartOrStopUndecided,
  isWorkerStopRequested
} from '../lifecycle/worker-exit-observation'

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

/** How a person's close stops a chat worker: worker-stop's settle, then its release. */
export type ClosedChatWorkerStop = {
  runtimeEpoch: string
  /** Read before the settle; the returned release runs once the stop committed. */
  releaseFor: (dispatchId: string) => () => void
}

/** A person closed a running chat worker: it is stopped as worker-stop stops one, and its
 *  coordinator hears who closed it, since the worker never reports for itself. */
export function reportChatWorkerClosedByPerson(
  closed: StructuredAgentSessionPersonClose,
  stop: ClosedChatWorkerStop,
  deps: WorkerTurnStopReportDeps
): void {
  try {
    const db = deps.getDb()
    if (!db) {
      return
    }
    for (const { dispatch, from } of chatWorkerDispatches(closed.sessionId, db)) {
      // A start still running reports its own outcome, and a stop asked for is no news; a start
      // left unknown has no one else to report the close.
      const state = db.getWorkerDispatch(dispatch.id)?.state
      if (state === 'starting' || isWorkerStopRequested(state)) {
        continue
      }
      const release = stop.releaseFor(dispatch.id)
      let stopped = false
      observeWorker(
        db,
        { kind: 'local', dispatch },
        {
          presence: 'gone',
          fence: `closed:${closed.sessionId}:${closed.fence}`,
          legacyStopKey: `closed:${closed.sessionId}:${closed.fence}`,
          gone: { from, reason: 'exited', closedBy: closed.closedBy, lastOutput: undefined },
          settle: () => {
            const begun = db.beginWorkerStop(dispatch.id, stop.runtimeEpoch, {
              closedByPerson: true
            })
            if (begun.disposition === 'context_only') {
              // A chat assigned work without a worker row is released as stopped right there.
              stopped = begun.state === 'stopped' && !begun.alreadySettled
            } else if (begun.disposition === 'stopping') {
              db.settleWorkerStop(dispatch.id)
              stopped = true
            }
            return stopped ? 'stopped' : undefined
          }
        },
        deps
      )
      if (stopped) {
        release()
      }
    }
  } catch (error) {
    console.warn('[orchestration] chat worker close report failed', closed.sessionId, error)
  }
}
