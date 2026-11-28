import type { AgentCliUpdateAgent } from '../../shared/agent-launch/installation/agent-cli-update'

const finishedListeners = new Set<(agent: AgentCliUpdateAgent) => void>()

export function notifyAgentCliUpdateFinished(agent: AgentCliUpdateAgent): void {
  // Every client re-checks, so none keeps an answer from before the update.
  for (const listener of finishedListeners) {
    try {
      listener(agent)
    } catch (error) {
      console.warn(`[agent-cli-update] ${agent} finish not announced:`, error)
    }
  }
}

/** Calls `listener` with each agent whose update on this host finished, succeeded or not. */
export function onAgentCliUpdateFinished(
  listener: (agent: AgentCliUpdateAgent) => void
): () => void {
  finishedListeners.add(listener)
  return () => finishedListeners.delete(listener)
}

let stopAnnouncing = (): void => {}

/** Announces each finished update as a client event, so every client checks again; the latest runtime's emitter replaces the last. */
export function announceAgentCliUpdatesFinished(
  emit: (event: { type: 'agentCliUpdateFinished'; agent: AgentCliUpdateAgent }) => void
): void {
  stopAnnouncing()
  stopAnnouncing = onAgentCliUpdateFinished((agent) =>
    emit({ type: 'agentCliUpdateFinished', agent })
  )
}
