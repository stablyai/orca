import type { StructuredAgentResolutionOperation } from '../structured-agent-command-resolution'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'

export type AgentModelCatalogResolvedProbe = {
  identity: unknown
  run: (signal?: AbortSignal) => Promise<AgentModelCatalogSuccess>
}

/** Recover reruns shell lookup after a miss; snapshot and saved never do. */
export type AgentModelCatalogLookup = 'saved' | 'snapshot' | 'recover'

export type AgentModelCatalogProbe = ((
  accountHome: AgentSessionAccountHome,
  options?: {
    signal?: AbortSignal
    workspacePath?: string
    cwd?: string
    operation?: StructuredAgentResolutionOperation
  }
) => Promise<AgentModelCatalogSuccess>) & {
  resolveLegacy?: (
    home: AgentSessionAccountHome,
    operation?: StructuredAgentResolutionOperation
  ) => Promise<AgentModelCatalogResolvedProbe>
  resolve?: (
    home: AgentSessionAccountHome,
    cwd: string,
    lookup?: AgentModelCatalogLookup,
    operation?: StructuredAgentResolutionOperation
  ) => Promise<AgentModelCatalogResolvedProbe>
}

export { independentAgentModelCatalog } from '../../../shared/agent-model-catalog-ownership'

/** Agents supply probes or opt out; the service owns caching, refresh and publication. */
export type AgentModelCatalogDiscovery =
  | {
      kind: 'probe'
      probe: AgentModelCatalogProbe
      /** True only when listing defaults match the account's actual configured model. */
      listingNamesConfiguredModel: boolean
      /** Project-dependent catalogs require a chat folder and cannot be prewarmed. */
      listsInChatFolder?: true
    }
  | { kind: 'unavailable'; reason: string }
