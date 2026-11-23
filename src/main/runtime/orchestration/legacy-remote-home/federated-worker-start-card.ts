import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { dispatchWorkerStarted, type WorkerStarted } from '../workers/launch/worker-start-card'

export function federatedWorkerStartCard(
  record: (start: WorkerStarted) => void,
  terminal: string | undefined,
  dispatchId: string,
  task: { id: string; spec: string },
  agent: () => AgentType | null,
  serverName: string
): (ready: boolean, failure?: string) => void {
  return (ready, failure) => {
    if (!terminal || failure) {
      record({
        ...dispatchWorkerStarted(ready, dispatchId, task, agent()),
        ...(failure ? { failure, machine: serverName } : {})
      })
    }
  }
}
