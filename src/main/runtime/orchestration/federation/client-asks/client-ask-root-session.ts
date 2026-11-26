import type { OrchestrationDb } from '../../db/orchestration-db'

// Coordinator chains are a few levels deep; the bound only stops a corrupt cycle.
const MAX_CHAIN = 32

/** The chat an asker acts for: itself, or for a worker, the coordinator at the top of its chain, so an
 *  introduction made in a chat covers the workers started from it. */
export function clientAskRootSession(db: OrchestrationDb, address: string): string {
  let current = address
  const seen = new Set<string>([current])
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    const dispatch = db.getLatestDispatchForTerminal(current)
    const coordinator = dispatch ? db.getRun(dispatch.run_id)?.coordinator_handle : null
    if (!coordinator || seen.has(coordinator)) {
      return current
    }
    seen.add(coordinator)
    current = coordinator
  }
  return current
}
