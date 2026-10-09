import type { AgentModelCatalogProbe } from './agent-model-catalog-store'

/**
 * What every agent registration must say about its models: a probe that lists them without
 * starting a session, or that it has none. Refresh, keying, persistence and publication are the
 * catalog service's, never the agent's. An agent with no probe shows the provider-default
 * placeholder until a live session reports.
 */
export type AgentModelCatalogDiscovery =
  | {
      kind: 'probe'
      probe: AgentModelCatalogProbe
      /** The listing marks the model the account is configured to run as its default, so a new
       *  chat launches the listed default. False where the agent's own settings may pick another. */
      listingNamesConfiguredModel: boolean
    }
  | { kind: 'unavailable'; reason: string }
