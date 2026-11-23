import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { WorkerTerminalResourceRow } from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import {
  deriveWorkerOutputReferenceFromSavedState,
  releaseCommitFieldsForCapturedArchive
} from '../../../../../orchestration/workers/archives/worker-output-archive'
import { resolveStructuredWorkerForDispatch } from '../../structured-workers/orchestration-structured-worker-lifecycle'

/** Exit-led release: the exact process is proven gone, so settle whatever the request state, keeping its output findable. */
export async function settleProvenExitedWorkerTerminal(args: {
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
}): Promise<WorkerTerminalResourceRow | null> {
  const { runtime, db, dispatchId, resource } = args
  const processIncarnation = resource.process_incarnation
  if (
    !processIncarnation ||
    (await runtime.inspectTerminalProcessIncarnationLiveness(
      processIncarnation,
      resource.host_scope
    )) !== 'exited'
  ) {
    return null
  }
  const structuredWorker = resolveStructuredWorkerForDispatch(db, resource.owner_dispatch_id)
  const settled = db.settleDeadWorkerTerminalRelease({
    requestingDispatchId: dispatchId,
    resourceId: resource.id,
    processIncarnation,
    expected: resource,
    // The saved session may have moved during the proof; read it from the row being settled.
    output: (current) =>
      releaseCommitFieldsForCapturedArchive(
        deriveWorkerOutputReferenceFromSavedState({ resource: current, structuredWorker })
      )
  })
  if (settled.disposition !== 'released') {
    return null
  }
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return settled.resource
}
