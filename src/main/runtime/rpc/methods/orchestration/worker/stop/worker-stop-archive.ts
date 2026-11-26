import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import {
  captureWorkerOutputReference,
  deriveWorkerOutputReferenceFromSavedState,
  releaseCommitFieldsForCapturedArchive
} from '../../../../../orchestration/workers/archives/worker-output-archive'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import { resolveStructuredWorkerForDispatch } from '../../structured-workers/orchestration-structured-worker-lifecycle'
import { orchestrationTimestampToMs } from '../output/worker-output'
import { captureWorkerResumeSession } from '../follow-up/worker-resume-session-capture'

/** Record where a worker's output lives before stop closes its terminal; release would otherwise find nothing to point at. */
export function archiveWorkerOutputBeforeStop(args: {
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  attachedAt: string
  /**
   * Set only once the worker's exact process is proven gone: its pane may be too, so when the pane names no
   * session, fall back to the newest one Orca saved while it ran, as an exit-proven release does.
   */
  exitProven?: boolean
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
    const structuredWorker = resolveStructuredWorkerForDispatch(db, dispatchId)
    let captured = captureWorkerOutputReference({
      runtime: args.runtime,
      terminalHandle: args.terminalHandle,
      attachedAtMs,
      structuredWorker
    })
    if (captured.status === 'unavailable' && args.exitProven) {
      // Read the session the capture above may just have saved.
      const saved = deriveWorkerOutputReferenceFromSavedState({
        resource: db.getWorkerTerminalResource(resource.id) ?? resource,
        structuredWorker
      })
      if (saved.status === 'captured') {
        captured = saved
      }
    }
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId,
      resourceId: resource.id,
      ...releaseCommitFieldsForCapturedArchive(captured)
    })
  } catch (error) {
    console.warn('[orchestration] worker output was not located before stop', dispatchId, error)
  }
}
