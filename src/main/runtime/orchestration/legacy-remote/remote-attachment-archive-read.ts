import type { RemoteDispatchAttachmentRow } from '../db/orchestration-records'
import type { WorkerTerminalReleaseRuntime } from '../terminal-authority/release/worker-terminal-release-runtime'
import { readArchivedWorkerOutput } from '../../rpc/methods/orchestration/worker/worker-archive-read'
import { OrchestrationError } from '../orchestration-error'

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

/** Release receipts carry the output only while its original is still readable. */
export function readRemoteAttachmentOutputIfAvailable(
  args: Parameters<typeof readRemoteAttachmentArchive>[0]
): ReturnType<typeof readRemoteAttachmentArchive> {
  return readRemoteAttachmentArchive(args).catch((error: unknown) => {
    if (error instanceof OrchestrationError && error.code === 'archive_unavailable') {
      return null
    }
    throw error
  })
}
