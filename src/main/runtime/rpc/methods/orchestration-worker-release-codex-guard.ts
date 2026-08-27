import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import type { WorkerReleaseReceipt } from './orchestration-worker-release-completion'

function workerRequestedCodex(startOptions: string | null): boolean {
  if (!startOptions) {
    return false
  }
  try {
    return (JSON.parse(startOptions) as { agent?: unknown }).agent === 'codex'
  } catch {
    return false
  }
}

export function deferCodexWorkerReleaseUntilThreadIdentity(args: {
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  workerStartOptions: string | null
}): WorkerReleaseReceipt | null {
  const refreshedResource = args.db.getWorkerTerminalResource(args.resource.id) ?? args.resource
  if (!workerRequestedCodex(args.workerStartOptions) || refreshedResource.codex_thread_id) {
    return null
  }
  const error =
    'Exact Codex thread identity is not proven yet; final release is deferred for safe retry.'
  const unknown = args.db.markWorkerTerminalReleaseUnknown(args.resource.id, error)
  const archive =
    unknown.archive_source || unknown.archive_status
      ? { source: unknown.archive_source, status: unknown.archive_status }
      : null
  return {
    dispatchId: args.dispatchId,
    state: 'release_unknown',
    processAction: 'none',
    archive,
    recovery:
      'Codex thread identity discovery will retry after provider-session updates or restart.',
    lastError: error
  }
}
