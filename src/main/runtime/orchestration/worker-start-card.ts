import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentType } from '../../../shared/agent-status-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationSessionCaller } from './orchestration-caller-identity'

/** No publication work participates in launch settlement, including lookup and logging failures. */
export function prepareWorkerStartCard(
  runtime: OrcaRuntimeService,
  callerSession: OrchestrationSessionCaller | undefined
): (args: {
  dispatchId: string
  workerAddress: string
  task: string
  /** What this start launched; the only kind known for a worker on another host. */
  agent: AgentType | null
}) => void {
  try {
    const host = getStructuredAgentSessionHost()
    const destination = callerSession && host?.captureAgentStartDestination(callerSession.sessionId)
    if (!host || !destination) {
      return () => {}
    }
    return (args) => {
      const observedAt = Date.now()
      void Promise.resolve()
        .then(async () => {
          const worker = runtime.orchestrationSenderNames.sender(
            args.workerAddress,
            args.dispatchId
          )
          await host.appendAgentStart(
            destination,
            {
              kind: 'agent-start',
              dispatchId: args.dispatchId,
              worker: worker.agent || !args.agent ? worker : { ...worker, agent: args.agent },
              task: args.task
            },
            observedAt
          )
        })
        .catch(logStartCardFailure)
    }
  } catch (error) {
    logStartCardFailure(error)
    return () => {}
  }
}

function logStartCardFailure(error: unknown): void {
  try {
    console.warn('[orchestration] recording a started worker in its caller chat failed', error)
  } catch {
    // Display bookkeeping cannot change a successful launch.
  }
}
