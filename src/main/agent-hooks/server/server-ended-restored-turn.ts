import type { EnrichedAgentHookEventPayload } from './server-types'

/** Proven process loss settles restored work without manufacturing a successful turn end. */
export function endedRestoredTurn(
  entry: EnrichedAgentHookEventPayload | undefined
): EnrichedAgentHookEventPayload | null {
  if (
    !entry?.providerSession ||
    !entry.payload.agentType ||
    entry.payload.agentType === 'unknown' ||
    entry.providerSessionOnly ||
    (!entry.restoredUnconfirmed && entry.payload.state !== 'done')
  ) {
    return null
  }
  const {
    launchToken: _launchToken,
    restoredUnconfirmed: _restored,
    turnEndedAt: _turnEndedAt,
    turnEndDisposition: _disposition,
    ...row
  } = entry
  const agentPresence = {
    ...entry.agentPresence,
    agent: entry.payload.agentType,
    ended: true as const
  }
  if (entry.payload.state === 'done') {
    return {
      ...row,
      agentPresence,
      turnEndedAt: entry.turnEndedAt,
      turnEndDisposition: entry.turnEndDisposition
    }
  }
  const payload = entry.payload
  return {
    ...row,
    agentPresence,
    stateStartedAt: entry.receivedAt,
    payload: {
      state: 'done',
      agentType: payload.agentType,
      prompt: payload.prompt,
      model: payload.model,
      lastAssistantMessage: payload.lastAssistantMessage,
      lastAssistantMessageIsToolOutput: payload.lastAssistantMessageIsToolOutput,
      mainAgent:
        payload.mainAgent?.state === 'done'
          ? payload.mainAgent
          : { state: 'done', outcome: 'interruption', stateStartedAt: entry.receivedAt }
    }
  }
}
