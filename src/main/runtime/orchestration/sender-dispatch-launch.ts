import type { OrchestrationDb } from './db'
import type { DispatchContextRow } from './types'
import { previousCustodianLookup } from './db/worker-terminal/worker-terminal-transfer'
import { workerStartOptionsAgent } from './worker-launch-observation'

/** Reused work inherits knowledge only through the same exact process and host custody. */
export function senderDispatchLaunch(
  db: OrchestrationDb
): (dispatch: DispatchContextRow) => string | null {
  const previous = previousCustodianLookup(db)
  const resolved = new Map<string, string | null>()
  return (dispatch) => {
    const path: string[] = []
    const visited = new Set<string>()
    let current: DispatchContextRow | undefined = dispatch
    let agent: string | null = null
    while (current && !visited.has(current.id)) {
      if (resolved.has(current.id)) {
        agent = resolved.get(current.id) ?? null
        break
      }
      visited.add(current.id)
      path.push(current.id)
      const worker = db.getWorkerDispatch(current.id)
      agent = worker ? workerStartOptionsAgent(worker.start_options) : null
      if (agent || !current.process_incarnation) {
        break
      }
      const id = previous(current)
      const predecessor = id ? db.getDispatchContextById(id) : undefined
      if (
        !predecessor ||
        predecessor.process_incarnation !== current.process_incarnation ||
        predecessor.host_scope !== current.host_scope ||
        predecessor.assignee_pane_key !== current.assignee_pane_key
      ) {
        break
      }
      current = predecessor
    }
    for (const id of path) {
      resolved.set(id, agent)
    }
    return agent
  }
}
