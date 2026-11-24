import { requireRunningStructuredWorker } from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { WorkerTerminalResourceRow } from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import { stopStructuredWorker } from '../../structured-workers/orchestration-structured-worker-lifecycle'
import type { StructuredWorkerIdentity } from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { archiveSummary, receiptForUnchangedRelease } from './worker-terminal-resource-presentation'
import type { WorkerReleaseReceipt } from './worker-release-completion'
import { releaseUnknownRecovery } from './worker-release-unknown-recovery'

/** Use host settlement to prove structured close; unproven closes remain release_unknown. Retry with a fresh request id because replay returns the old receipt. */
export async function stopStructuredWorkerForRelease(args: {
  structured: StructuredWorkerIdentity
  dispatchId: string
  resource: WorkerTerminalResourceRow
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  archiveSource: string | null
  archiveStatus: string | null
}): Promise<WorkerReleaseReceipt> {
  const { structured, dispatchId, resource, runtime, db } = args
  // Only an automatic release can be refused; an explicit one keeps cutting through a hung start.
  const stop = await stopStructuredWorker(
    structured,
    runtime,
    resource.auto_release_at
      ? (work) => {
          const current = db.getWorkerTerminalResource(resource.id)
          if (
            current?.owner_dispatch_id !== resource.owner_dispatch_id ||
            current.terminal_handle !== structured.handle ||
            current.pane_key !== structured.paneKey ||
            current.process_incarnation !== structured.processIncarnation
          ) {
            return false
          }
          const sameSubject = (() => {
            try {
              return requireRunningStructuredWorker(structured).sessionId === work.sessionId
            } catch {
              return false
            }
          })()
          const admitted = db.admitWorkerChatReleaseClose(
            resource.id,
            () => !sameSubject || work.state !== 'idle',
            !sameSubject || work.state === 'unknown'
          )
          return sameSubject && admitted
        }
      : undefined
  )
  if (!stop.stopped) {
    const current = db.getWorkerTerminalResource(resource.id)
    if (current?.owner_dispatch_id !== dispatchId || current.release_state !== 'releasing') {
      // Refused in the session lane: Keep open, a new turn, a fall back to manual release, or another custody.
      return receiptForUnchangedRelease(dispatchId, current)
    }
    const unknown = db.markWorkerTerminalReleaseUnknown(
      resource.id,
      stop.reason ?? 'The structured session close was not proven.',
      dispatchId
    )
    if (unknown.release_state !== 'unknown') {
      return receiptForUnchangedRelease(dispatchId, unknown)
    }
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: stop.closeAttempted ? 'closed_agent_terminal' : 'none',
      archive: { source: args.archiveSource, status: args.archiveStatus },
      lastError: unknown.release_error ?? stop.reason,
      recovery: releaseUnknownRecovery(dispatchId)
    }
  }
  const settled = db.settleWorkerTerminalRelease(resource.id, dispatchId)
  if (settled.owner_dispatch_id !== dispatchId || settled.release_state !== 'released') {
    return receiptForUnchangedRelease(dispatchId, settled, 'closed_agent_terminal')
  }
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction: 'closed_agent_terminal',
    archive: archiveSummary(settled)
  }
}
