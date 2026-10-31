import type { OrchestrationDb } from './db'
import { resolveStructuredWorkerIdentityForSession } from '../structured-worker-authority'
import { releaseStructuredWorkerSession } from '../rpc/methods/orchestration-structured-worker-session'

/** Capture the ordinary worker Stop before closing; release redrive even when exit is unknown. */
export function captureStructuredWorkerSwitchStop(
  sessionId: string,
  db: OrchestrationDb | null,
  runtimeEpoch: string,
  runtime: { forgetStructuredSessionMail(sessionId: string): void }
): ((proven: boolean) => void) | undefined {
  const identity = resolveStructuredWorkerIdentityForSession(sessionId, db)
  const resource = identity && db?.getWorkerTerminalResourceByHandle(identity.handle)
  const dispatchId = resource?.owner_dispatch_id
  if (
    !identity ||
    !dispatchId ||
    !db ||
    !db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation
    })
  ) {
    return undefined
  }
  const worker = db.getWorkerDispatch(dispatchId)
  if (worker && ['ready', 'start_unknown'].includes(worker.state)) {
    db.beginWorkerStop(dispatchId, runtimeEpoch)
  }
  return (proven) => {
    try {
      if (
        db.isDispatchProcessCurrent({
          dispatchId,
          paneKey: identity.paneKey,
          processIncarnation: identity.processIncarnation
        }) &&
        db.getWorkerDispatch(dispatchId)?.state === 'stopping'
      ) {
        if (proven) {
          db.settleWorkerStop(dispatchId)
        } else {
          db.markWorkerStopUnknown(
            dispatchId,
            'The agent stop could not be confirmed. Retry Stop to check its exit.'
          )
        }
      }
    } finally {
      releaseStructuredWorkerSession(identity.sessionId, runtime)
    }
  }
}
