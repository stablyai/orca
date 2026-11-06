import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'

/** An automatic close yields to an agent working again, as after a follow-up; its countdown restarts when it rests.
 *  Checked just before the close, after the output archive committed. */
export function yieldAutoReleaseToWorkingAgent(
  runtime: WorkerTerminalReleaseRuntime,
  resource: WorkerTerminalResourceRow
): WorkerTerminalResourceRow {
  if (
    !resource.auto_release_at ||
    resource.auto_release_dispatch_id !== resource.owner_dispatch_id ||
    !runtime.isWorkerAgentInTurn(resource)
  ) {
    return resource
  }
  const db = runtime.getOrchestrationDb()
  db.deferWorkerTerminalAutoRelease(resource.id)
  return db.getWorkerTerminalResource(resource.id) ?? resource
}
