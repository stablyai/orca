import type { RemoteDispatchAttachmentRow } from '../db/orchestration-records'
import type { WorkerTerminalReleaseRuntime } from '../terminal-authority/release/worker-terminal-release-runtime'
import { readArchivedWorkerOutput } from '../../rpc/methods/orchestration/worker/output/worker-archive-read'
import { OrchestrationError } from '../orchestration-error'

export async function readRemoteAttachmentArchive(args: {
  runtime: WorkerTerminalReleaseRuntime
  attachment: RemoteDispatchAttachmentRow
  source?: 'auto' | 'transcript' | 'terminal'
  cursor?: string | number
  limit?: number
  liveness?: 'live' | 'unverifiable' | 'exited'
}) {
  const db = args.runtime.getOrchestrationDb()
  const archive = db.getWorkerTerminalArchive(args.attachment.dispatch_id)
  if (!archive || !args.attachment.terminal_handle) {
    return null
  }
  return readArchivedWorkerOutput({
    db,
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

/** Release receipts carry the output only while its original is still readable and steady. */
export function readRemoteAttachmentOutputIfAvailable(
  args: Parameters<typeof readRemoteAttachmentArchive>[0]
): ReturnType<typeof readRemoteAttachmentArchive> {
  return readRemoteAttachmentArchive(args).catch((error: unknown) => {
    // A transcript written during the read only drops the optional page; it never blocks release.
    if (
      error instanceof OrchestrationError &&
      (error.code === 'archive_unavailable' || error.code === 'source_changed')
    ) {
      return null
    }
    throw error
  })
}
