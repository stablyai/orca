import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import { readArchivedWorkerOutput } from '../worker/worker-archive-read'

export async function readRemoteAttachmentArchive(args: {
  runtime: WorkerTerminalReleaseRuntime
  attachment: RemoteDispatchAttachmentRow
  source?: 'auto' | 'transcript' | 'terminal'
  cursor?: string | number
  limit?: number
  liveness?: 'live' | 'unverifiable' | 'exited'
}) {
  const archive = args.runtime
    .getOrchestrationDb()
    .getWorkerTerminalArchive(args.attachment.dispatch_id)
  if (!archive || !args.attachment.terminal_handle) {
    return null
  }
  return readArchivedWorkerOutput({
    db: args.runtime.getOrchestrationDb(),
    dispatchId: args.attachment.dispatch_id,
    workerState: args.attachment.state,
    resource: {
      id: `remote-attachment:${args.attachment.dispatch_id}`,
      terminal_handle: args.attachment.terminal_handle,
      release_state: args.attachment.stage === 'released' ? 'released' : 'releasing'
    },
    source: args.source,
    cursor: args.cursor,
    limit: args.limit,
    liveness: args.liveness
  })
}
