import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  captureWorkerOutputReference,
  releaseCommitFieldsForCapturedArchive
} from '../../../../orchestration/workers/archives/worker-output-archive'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import { resolveStructuredWorkerForDispatch } from '../structured-workers/orchestration-structured-worker-lifecycle'
import { orchestrationTimestampToMs } from './worker-output'
import { captureWorkerResumeSession } from './worker-resume-session-capture'

/** Record where a worker's output lives before stop closes its terminal; release would otherwise find nothing to point at. */
export function archiveWorkerOutputBeforeStop(args: {
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  attachedAt: string
}): void {
  const { db, dispatchId } = args
  // Stopping matters more than the reference; on failure, release reports the output unavailable.
  try {
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    const attachedAtMs = orchestrationTimestampToMs(args.attachedAt)
    if (resource) {
      captureWorkerResumeSession(args.runtime, db, resource, attachedAtMs)
    }
    if (
      !resource ||
      resource.ownership_state !== 'owned' ||
      db.hasWorkerTerminalArchive(dispatchId)
    ) {
      return
    }
    const captured = captureWorkerOutputReference({
      runtime: args.runtime,
      terminalHandle: args.terminalHandle,
      attachedAtMs,
      structuredWorker: resolveStructuredWorkerForDispatch(db, dispatchId)
    })
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId,
      resourceId: resource.id,
      ...releaseCommitFieldsForCapturedArchive(captured)
    })
  } catch (error) {
    console.warn('[orchestration] worker output was not located before stop', dispatchId, error)
  }
}
