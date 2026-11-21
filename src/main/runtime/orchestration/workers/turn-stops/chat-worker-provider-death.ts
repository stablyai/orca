import type { StructuredAgentSessionIdleDeath } from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import { reportWorkerTurnStop, type WorkerTurnStopReportDeps } from './worker-turn-stop-report'

/** A chat worker's provider died with no turn running: nothing else tells its coordinator. Once per session and provider
 *  generation, since mail starts the chat again and a later death is news again. */
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
      const state = db.getWorkerDispatch(dispatch.id)?.state
      // A start still being decided reports its own outcome; a stop the coordinator asked for is no news.
      if (
        state === 'starting' ||
        state === 'start_unknown' ||
        state === 'stopping' ||
        state === 'stop_unknown'
      ) {
        continue
      }
      reportWorkerTurnStop(
        db,
        { kind: 'local', dispatch },
        {
          from,
          reason: 'exited',
          stopKey: `exit:${death.sessionId}:${death.fence}`,
          ...(death.reason ? { cause: death.reason } : {}),
          restartsOnMail: true,
          lastOutput: undefined
        },
        deps
      )
    }
  } catch (error) {
    console.warn('[orchestration] chat worker exit report failed', death.sessionId, error)
  }
}
