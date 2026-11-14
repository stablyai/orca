import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionEventTarget } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { StructuredAgentSessionSettledTurnRoutes } from '../agent-session-wire/host/structured-agent-session-settled-turn-routes'

const settledTurnRoutes = new WeakMap<
  AgentSessionJournal,
  StructuredAgentSessionSettledTurnRoutes
>()

export function boundTarget(journal: AgentSessionJournal): StructuredAgentSessionEventTarget {
  let routes = settledTurnRoutes.get(journal)
  if (!routes) {
    routes = new StructuredAgentSessionSettledTurnRoutes({ warn: () => {}, error: () => {} })
    settledTurnRoutes.set(journal, routes)
    const captured = routes
    journal.observeCommits((commit) =>
      captured.deliver(journal.identity.sessionId, journal, commit)
    )
  }
  const route = routes
  return {
    journal,
    fence: 1,
    publish: () => {},
    observeSettledTurns: (listener) => route.observe(journal.identity.sessionId, journal, listener)
  }
}
