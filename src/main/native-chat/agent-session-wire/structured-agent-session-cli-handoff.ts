import type { AgentProcessIdentity } from '../../../shared/agent-process-presence'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionReserveRequest } from '../../runtime/agent-session-reservation-admission'
import type { CliSourceStopHost } from '../../runtime/structured-agent-cli-stop'
import {
  captureCliSourceProcessIdentities,
  inspectCliSourceWriters,
  probeCliSourceSurvivors,
  stopCliSourceAndJudge
} from '../../runtime/structured-agent-cli-stop'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'

type CliSource = {
  host: CliSourceStopHost
  resumeFrom: StructuredAgentSessionResumeSource
  workspaceId: string
}

/** Reserve before stopping so every other managed writer sees the adopting chat. */
export async function stopCliSourceBeforeAdoption(input: {
  store: StructuredAgentSessionAttachContext['deps']['store']
  request: AgentSessionReserveRequest
  source: CliSource
  agent: StructuredAgentId
  priorSurvivors: AgentProcessIdentity[] | undefined
  onReserved: () => void
  onCancelledBeforeStop: () => void
}): Promise<void> {
  const { store, request, source, agent, priorSurvivors } = input
  const pane = await inspectCliSourceWriters(source.host, {
    agent,
    resumeFrom: priorSurvivors === undefined
      ? source.resumeFrom
      : { providerSessionId: source.resumeFrom.providerSessionId },
    workspaceId: source.workspaceId
  })
  await store.founding.reserveAdoption(request)
  input.onReserved()
  if (priorSurvivors !== undefined) {
    const survivors = await probeCliSourceSurvivors(priorSurvivors)
    await store.founding.adoptionSurvivors(request, survivors)
    if (survivors.length > 0) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'terminalStopUnconfirmed'
      })
    }
    return
  }
  if (!pane) {
    return
  }
  let identities: AgentProcessIdentity[]
  try {
    identities = await captureCliSourceProcessIdentities(source.host, pane.ptyId)
    await store.founding.adoptionSurvivors(request, identities)
  } catch {
    const refusal = {
      code: 'agent_session_conflict' as const,
      details: { reason: 'conversationHeldElsewhere' as const },
      message: 'The terminal process could not be verified. Exit it there, then retry.'
    }
    await store.founding.cancelAdoptionBeforeStop(request, refusal)
    input.onCancelledBeforeStop()
    throw agentSessionRefusalError(refusal.code, refusal.details)
  }
  const survivors = await stopCliSourceAndJudge(
    source.host, pane.workspaceId, pane.ptyId, identities
  )
  await store.founding.adoptionSurvivors(request, survivors)
  if (survivors.length > 0) {
    throw agentSessionRefusalError('agent_session_conflict', {
      reason: 'terminalStopUnconfirmed'
    })
  }
}
