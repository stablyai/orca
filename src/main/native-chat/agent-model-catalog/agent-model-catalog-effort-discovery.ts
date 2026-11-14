import {
  agentModelEffortProbeDue,
  recordAgentModelCatalogPartialAttempt
} from './agent-model-catalog-entry-lifetime'
import { demandAgentModelEfforts, type InFlightListing } from './agent-model-catalog-lister'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'

/** Target demand shares the catalog's flights and bounded partial-attempt lifetime. */
export function createAgentModelEffortDiscovery(input: {
  entries: ReadonlyMap<string, AgentModelCatalogEntry>
  refreshes: ReadonlyMap<string, InFlightListing>
  attempts: Map<string, { agent: string; at: number }>
  failed: (fingerprint: string) => boolean
  now: () => number
  cap: number
}) {
  return {
    catalogAttempted(fingerprint: string, agent: string, complete: boolean): void {
      input.attempts.delete(fingerprint)
      if (!complete) {
        recordAgentModelCatalogPartialAttempt(
          input.attempts,
          fingerprint,
          agent,
          input.now(),
          input.cap
        )
      }
    },
    due: (fingerprint: string, model: string | undefined): boolean =>
      !input.failed(fingerprint) &&
      agentModelEffortProbeDue(input.entries.get(fingerprint), input.attempts, model),
    demand: (fingerprint: string, model: string | undefined): void =>
      demandAgentModelEfforts(input.refreshes.get(fingerprint), model, input.cap),
    attempted: (fingerprint: string, agent: string, model: string): void =>
      recordAgentModelCatalogPartialAttempt(
        input.attempts,
        JSON.stringify([fingerprint, model]),
        agent,
        input.now(),
        input.cap
      )
  }
}
