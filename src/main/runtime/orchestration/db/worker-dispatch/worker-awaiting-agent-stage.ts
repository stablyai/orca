/** A start whose agent wasn't ready at its caller's budget: Orca watches on in this runtime, with no
 *  brief typed, so a stop may end it and a restart fails it. */
export const WORKER_AWAITING_AGENT_STAGE = 'awaiting_agent'

/** Such a start has typed nothing yet, so it stops as a running worker does. */
export function isWorkerAwaitingAgent(worker: { state: string; stage: string }): boolean {
  return worker.state === 'starting' && worker.stage === WORKER_AWAITING_AGENT_STAGE
}

/** A worker a stop can begin on: running, of unknown start, or still waiting on its agent. */
export function isWorkerStoppable(worker: { state: string; stage: string }): boolean {
  return (
    worker.state === 'ready' || worker.state === 'start_unknown' || isWorkerAwaitingAgent(worker)
  )
}
