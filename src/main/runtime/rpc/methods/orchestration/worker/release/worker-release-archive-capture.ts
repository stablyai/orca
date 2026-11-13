import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../../../shared/orchestration/orchestration-session-caller-codes'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../../orchestration/orchestration-error'
import {
  captureWorkerOutputReference,
  type WorkerOutputArchiveCapture
} from '../../../../../orchestration/workers/archives/worker-output-archive'
import type { WorkerTerminalResourceRow } from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { WorkerReleaseReceipt } from './worker-release-completion'
import { releaseUnknownRecovery } from './worker-release-unknown-recovery'
import { archiveSummary } from './worker-terminal-resource-presentation'
import { captureWorkerResumeSession } from '../follow-up/worker-resume-session-capture'

/** Record where release output lives; unverifiable structured sessions finish release_unknown instead of retrying forever as requested. A fresh request may retry. */
export function captureWorkerReleaseArchive(
  args: Parameters<typeof captureWorkerOutputReference>[0] & {
    db: OrchestrationDb
    resource: WorkerTerminalResourceRow
    dispatchId: string
  }
): { captured: WorkerOutputArchiveCapture } | { receipt: WorkerReleaseReceipt } {
  const { db, resource, dispatchId, ...capture } = args
  captureWorkerResumeSession(capture.runtime, db, resource, capture.attachedAtMs)
  try {
    return { captured: captureWorkerOutputReference(capture) }
  } catch (error) {
    if (!capture.structuredWorker || !isUnverifiableSessionRefusal(error)) {
      throw error
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, error.message)
    return {
      receipt: {
        dispatchId,
        state: 'release_unknown',
        processAction: 'none',
        archive: archiveSummary(unknown),
        lastError: unknown.release_error ?? error.message,
        recovery: releaseUnknownRecovery(dispatchId)
      }
    }
  }
}

function isUnverifiableSessionRefusal(error: unknown): error is OrchestrationError {
  return (
    error instanceof OrchestrationError &&
    (error.code === CODES.notLive || error.code === CODES.hostBoundary)
  )
}
