import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { readArchivedWorkerOutput } from '../worker/worker-archive-read'

export async function readRemoteAttachmentArchive(args: {
  runtime: OrcaRuntimeService
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

export function projectArchivedOutputLiveness<
  T extends { status: { terminal: string; liveness: string } }
>(output: T, liveness: 'live' | 'unverifiable' | 'exited'): T {
  return {
    ...output,
    status: {
      ...output.status,
      terminal: liveness === 'live' ? 'running' : liveness === 'exited' ? 'exited' : 'unknown',
      liveness
    }
  }
}
