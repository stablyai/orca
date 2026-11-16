import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkerStopReceipt } from '../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import { archiveWorkerOutputBeforeStop } from '../../rpc/methods/orchestration/worker/stop/worker-stop-archive'
import { describeUnconfirmedAgentStop } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { inspectRemoteAttachment } from './federation-attachment-observation'

/** Close the exact attached worker this host runs for its home. */
export async function stopRemoteAttachment(
  runtime: OrcaRuntimeService,
  params: { dispatchId: string }
): Promise<WorkerStopReceipt> {
  const db = runtime.getOrchestrationDb()
  const begun = db.beginRemoteAttachmentStop(params.dispatchId)
  if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(begun.state)) {
    return {
      dispatchId: params.dispatchId,
      state: begun.state,
      alreadySettled: true,
      processAction: 'none'
    }
  }
  const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
  if (!observation.exact || !observation.terminal) {
    const attachment = db.markRemoteAttachmentStopUnknown(
      params.dispatchId,
      `The recorded worker process is ${observation.status}; no terminal was closed.`
    )
    return {
      dispatchId: params.dispatchId,
      state: attachment.state,
      alreadySettled: false,
      processAction: 'none',
      lastError: attachment.last_error
    }
  }
  archiveWorkerOutputBeforeStop({
    runtime,
    db,
    dispatchId: params.dispatchId,
    terminalHandle: observation.terminal.handle,
    attachedAt: begun.created_at
  })
  try {
    const close = await runtime.closeTerminal(observation.terminal.handle)
    if (!close.ptyKilled) {
      // The tab is retired but the process was never confirmed stopped, so
      // the coordinator must not be told this dispatch reached 'stopped'.
      const attachment = db.markRemoteAttachmentStopUnknown(
        params.dispatchId,
        describeUnconfirmedAgentStop(close)
      )
      return {
        dispatchId: params.dispatchId,
        state: attachment.state,
        alreadySettled: false,
        processAction: 'closed_agent_terminal',
        lastError: attachment.last_error,
        close
      }
    }
    const attachment = db.settleRemoteAttachmentStop(params.dispatchId)
    return {
      dispatchId: params.dispatchId,
      state: attachment.state,
      alreadySettled: false,
      processAction: 'closed_agent_terminal',
      close
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const attachment = db.markRemoteAttachmentStopUnknown(params.dispatchId, reason)
    return {
      dispatchId: params.dispatchId,
      state: attachment.state,
      alreadySettled: false,
      processAction: 'unknown',
      lastError: reason
    }
  }
}
