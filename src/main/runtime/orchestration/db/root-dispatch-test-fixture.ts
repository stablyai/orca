import type { DispatchContextRow } from '../types'
import type { OrchestrationDb } from './orchestration-db'

/**
 * Dispatch as a root coordinator with no nesting cap.
 *
 * Tests that predate nesting depth care about dispatch behaviour, not the cap;
 * this keeps them at their original call shape instead of repeating the same
 * creator/maxDepth pair at every site.
 */
export function createRootDispatch(
  db: OrchestrationDb,
  taskId: string,
  assigneeHandle: string,
  assigneePaneKey?: string,
  launchTokenHash?: string,
  processIncarnation?: string
): DispatchContextRow {
  return db.createDispatchContext({
    taskId,
    assigneeHandle,
    assigneePaneKey,
    launchTokenHash,
    processIncarnation,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
}
