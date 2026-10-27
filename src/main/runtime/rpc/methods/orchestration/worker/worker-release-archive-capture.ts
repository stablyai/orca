import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../../shared/orchestration-session-caller-codes'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  captureWorkerOutputArchive,
  type WorkerOutputArchiveCapture
} from '../../../../orchestration/worker-output-archive'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { releaseUnknownRecovery, type WorkerReleaseReceipt } from './worker-release-completion'
import { archiveSummary } from './worker-terminal-resource-presentation'

/** Freeze release output; unverifiable structured sessions finish release_unknown instead of retrying forever as requested. A fresh request may retry. */
export async function captureWorkerReleaseArchive(
  args: Parameters<typeof captureWorkerOutputArchive>[0] & {
    db: OrchestrationDb
    resource: WorkerTerminalResourceRow
  }
): Promise<{ captured: WorkerOutputArchiveCapture } | { receipt: WorkerReleaseReceipt }> {
  const { db, resource, ...capture } = args
  try {
    return { captured: await captureWorkerOutputArchive(capture) }
  } catch (error) {
    if (!capture.structuredWorker || !isUnverifiableSessionRefusal(error)) {
      throw error
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(resource.id, error.message)
    return {
      receipt: {
        dispatchId: capture.dispatchId,
        state: 'release_unknown',
        processAction: 'none',
        archive: archiveSummary(unknown),
        lastError: unknown.release_error ?? error.message,
        recovery: releaseUnknownRecovery(capture.dispatchId)
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
