import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TaskRow } from '../db/orchestration-records'
import { dispatchWorkerStarted, type WorkerStarted } from '../workers/launch/worker-start-card'

export function federatedWorkerStartCard(
  record: (start: WorkerStarted) => void,
  terminal: string | undefined,
  dispatchId: string,
  task: TaskRow,
  agent: () => AgentType | null,
  serverName: string
): (ready: boolean, failure?: string) => void {
  return (ready, failure) => {
    if (!terminal) {
      record({
        ...dispatchWorkerStarted(ready, dispatchId, task, agent()),
        ...(failure ? { failure, machine: serverName } : {})
      })
    }
  }
}
