import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type {
  AgentJournalAgentHandoffItem,
  AgentJournalAgentStartItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentMessageSender } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentType } from '../../../shared/agent-status-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationSessionCaller } from './orchestration-caller-identity'

export type AgentCreationCard = AgentJournalAgentStartItem | AgentJournalAgentHandoffItem

/** Capture the caller's chat before its agent starts another; null when there is none.
 *  No publication work participates in launch settlement, including lookup and logging failures. */
export function prepareAgentCreationCard(
  callerSessionId: string | undefined
): ((card: () => AgentCreationCard) => void) | null {
  try {
    const host = getStructuredAgentSessionHost()
    const destination = callerSessionId && host?.captureAgentStartDestination(callerSessionId)
    if (!host || !destination) {
      return null
    }
    return (card) => {
      const observedAt = Date.now()
      void Promise.resolve()
        .then(async () => {
          await host.appendAgentStart(destination, card(), observedAt)
        })
        .catch(logStartCardFailure)
    }
  } catch (error) {
    logStartCardFailure(error)
    return null
  }
}

/** The started agent's sender, keeping the kind the launch knows when the lookup can't find it. */
export function startedAgentSender(
  runtime: OrcaRuntimeService,
  address: string,
  agent: AgentType | null,
  dispatchId?: string
): AgentMessageSender {
  const sender = runtime.orchestrationSenderNames.sender(address, dispatchId)
  return sender.agent || !agent ? sender : { ...sender, agent }
}

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
  const publish = prepareAgentCreationCard(callerSession?.sessionId)
  if (!publish) {
    return () => {}
  }
  return (args) =>
    publish(() => ({
      kind: 'agent-start',
      dispatchId: args.dispatchId,
      worker: startedAgentSender(runtime, args.workerAddress, args.agent, args.dispatchId),
      task: args.task
    }))
}

function logStartCardFailure(error: unknown): void {
  try {
    console.warn('[orchestration] recording a started agent in its caller chat failed', error)
  } catch {
    // Display bookkeeping cannot change a successful launch.
  }
}
