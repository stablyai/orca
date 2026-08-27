import type { OrchestrationDb } from '../../orchestration/db'

export function bindCodexThreadDuringRelease(db: OrchestrationDb) {
  return async (dispatchId: string): Promise<void> => {
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource || resource.codex_thread_id || resource.ownership_state !== 'owned') {
      return
    }
    db.recordWorkerCodexThreadIdentity({
      dispatchId,
      resourceId: resource.id,
      threadId: `thread-${dispatchId}`,
      autoName: 'Release fixture task'
    })
    db.markWorkerCodexThreadNameOutcome(resource.id, 'applied')
  }
}
