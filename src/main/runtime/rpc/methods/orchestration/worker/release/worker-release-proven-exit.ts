import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import {
  decideWorkerTerminalRelease,
  type WorkerTerminalResourceRow,
  type WorkerTerminalRetainedReason
} from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import {
  deriveWorkerOutputReferenceFromSavedState,
  releaseCommitFieldsForCapturedArchive
} from '../../../../../orchestration/workers/archives/worker-output-archive'
import { resolveStructuredWorkerForDispatch } from '../../structured-workers/orchestration-structured-worker-lifecycle'
import type { WorkerReleaseReceipt } from './worker-release-completion'
import { receiptForUnchangedRelease } from './worker-terminal-resource-presentation'
import { readWorkerTerminalReleaseAttempt } from '../../../../../orchestration/db/worker-terminal/worker-terminal-release-attempt'

/** Exit-led release: the exact process is proven gone, so settle whatever the request state, keeping its output findable. */
export async function settleProvenExitedWorkerTerminal(args: {
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  /** The keep-open revision read with `resource`; a keep-open during the proof refuses the settle. */
  expectedAttempt?: number
}): Promise<WorkerTerminalResourceRow | null> {
  const { runtime, db, dispatchId, resource } = args
  const processIncarnation = resource.process_incarnation
  if (
    // A former owner's lookup describes custody; it never authorizes releasing the current owner's row.
    resource.owner_dispatch_id !== dispatchId ||
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
    expected:
      args.expectedAttempt === undefined
        ? resource
        : { ...resource, releaseAttempt: args.expectedAttempt },
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

/** A retained release's receipt from the row as it is now, since a keep-open, transfer or release may have landed during the proof. */
export function readRetainedWorkerReleaseState(
  db: OrchestrationDb,
  dispatchId: string,
  seen: WorkerTerminalResourceRow,
  seenReason: WorkerTerminalRetainedReason,
  seenAttempt?: number
):
  | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
  | {
      disposition: 'retained'
      resource: WorkerTerminalResourceRow | null
      reason: WorkerTerminalRetainedReason
    } {
  const current = db.getWorkerTerminalResource(seen.id)
  if (!current) {
    return { disposition: 'retained', resource: null, reason: 'no_owned_resource' }
  }
  if (current.owner_dispatch_id !== dispatchId) {
    // Custody moved during this release's own proof: the winner's row, and its output summary, are not this receipt's.
    return { disposition: 'retained', resource: null, reason: 'ownership_transferred' }
  }
  const decision = decideWorkerTerminalRelease(current)
  if (decision.action === 'already_released') {
    return { disposition: 'already_released', resource: current }
  }
  return {
    disposition: 'retained',
    resource: current,
    // Still releasable by its owner: whatever retained it before the proof (a stopped worker's unproven identity) still holds.
    reason:
      decision.action === 'retained'
        ? decision.reason
        : (reasonKeptOpenSince(db, current, seenAttempt) ?? seenReason)
  }
}

/** When a keep-open landed after `seenAttempt` was read, its reason, not the admission's, holds the row. */
function reasonKeptOpenSince(
  db: OrchestrationDb,
  current: WorkerTerminalResourceRow,
  seenAttempt: number | undefined
): WorkerTerminalRetainedReason | null {
  return seenAttempt !== undefined &&
    current.release_state === 'retained' &&
    current.retained_reason !== null &&
    readWorkerTerminalReleaseAttempt(db, current.id) !== seenAttempt
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every writer of a retained row's reason writes one of these.
      (current.retained_reason as WorkerTerminalRetainedReason)
    : null
}

/**
 * A requested release's receipt once its exit was not proven, when something settled the row meanwhile;
 * null while it is still this dispatch's release to resolve. Another dispatch's custody is never reported as this one's.
 */
export function readRequestedWorkerReleaseState(
  db: OrchestrationDb,
  dispatchId: string,
  resourceId: string
): WorkerReleaseReceipt | null {
  const current = db.getWorkerTerminalResource(resourceId)
  const stillThisRelease =
    current?.owner_dispatch_id === dispatchId &&
    current.release_state !== 'released' &&
    current.release_state !== 'retained'
  return stillThisRelease ? null : receiptForUnchangedRelease(dispatchId, current)
}
