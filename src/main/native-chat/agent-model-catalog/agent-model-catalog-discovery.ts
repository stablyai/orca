import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'

export type AgentModelCatalogResolvedProbe = {
  identity: unknown
  run: (signal?: AbortSignal) => Promise<AgentModelCatalogSuccess>
}

/** The shell env a resolution reads: the saved capture only, the current snapshot, or (the
 *  default) that snapshot reread by a fresh shell run when it finds no program. */
export type AgentModelCatalogLookup = 'saved' | 'snapshot' | 'recover'

export type AgentModelCatalogProbe = ((
  accountHome: AgentSessionAccountHome,
  options?: { signal?: AbortSignal; workspacePath?: string; cwd?: string }
) => Promise<AgentModelCatalogSuccess>) & {
  resolveLegacy?: (home: AgentSessionAccountHome) => Promise<AgentModelCatalogResolvedProbe>
  resolve?: (
    home: AgentSessionAccountHome,
    cwd: string,
    lookup?: AgentModelCatalogLookup
  ) => Promise<AgentModelCatalogResolvedProbe>
}

export { independentAgentModelCatalog } from '../../../shared/agent-model-catalog-ownership'

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
      /** The listing runs in the asking chat's folder and reads its project config: each folder
       *  keeps its own catalog, and a prewarm, which has no chat, never runs it. */
      listsInChatFolder?: true
    }
  | { kind: 'unavailable'; reason: string }
