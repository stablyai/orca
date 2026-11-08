import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionEventTarget } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { journalSettledTurnItemIds } from '../agent-session-journal/item-lifecycle/journal-settled-turns'

/** Route each commit's settled turns to bound sinks as the host's conversation owner does. */
const settledTurnRoutes = new WeakMap<
  AgentSessionJournal,
  Set<(turnItemIds: readonly string[]) => void>
>()

export function boundTarget(journal: AgentSessionJournal): StructuredAgentSessionEventTarget {
  let listeners = settledTurnRoutes.get(journal)
  if (!listeners) {
    const routed = new Set<(turnItemIds: readonly string[]) => void>()
    listeners = routed
    settledTurnRoutes.set(journal, routed)
    journal.observeCommits((rows) => {
      const turnItemIds = rows ? journalSettledTurnItemIds(rows) : []
      if (turnItemIds.length > 0) {
        for (const listener of routed) {
          listener(turnItemIds)
        }
      }
    })
  }
  const route = listeners
  return {
    journal,
    fence: 1,
    publish: () => {},
    observeSettledTurns: (listener) => {
      route.add(listener)
      return () => {
        route.delete(listener)
      }
    }
  }
}
