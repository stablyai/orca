import type { StructuredAgentResolutionOperation } from '../structured-agent-command-resolution'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'

export type AgentModelCatalogResolvedProbe = {
  identity: unknown
  /** `operation` owns the run; it defaults to the one the invocation was resolved under. */
  run: (
    signal?: AbortSignal,
    operation?: StructuredAgentResolutionOperation
  ) => Promise<AgentModelCatalogSuccess>
}

/** Recover reruns shell lookup after a miss; snapshot and saved never do. */
export type AgentModelCatalogLookup = 'saved' | 'snapshot' | 'recover'

export type AgentModelCatalogProbe = ((
  accountHome: AgentSessionAccountHome,
  options?: {
    signal?: AbortSignal
    workspacePath?: string
    cwd?: string
    selectedModels?: readonly string[]
    operation?: StructuredAgentResolutionOperation
  }
) => Promise<AgentModelCatalogSuccess>) & {
  /** False when this account's runtime has no out-of-session listing (such as a managed fallback). */
  supportsAccount?: (home: AgentSessionAccountHome) => boolean
  resolveLegacy?: (
    home: AgentSessionAccountHome,
    operation?: StructuredAgentResolutionOperation
  ) => Promise<AgentModelCatalogResolvedProbe>
  resolve?: (
    home: AgentSessionAccountHome,
    cwd: string,
    lookup?: AgentModelCatalogLookup,
    operation?: StructuredAgentResolutionOperation,
    /** Where a chat would launch, for resolving the executable; the listing still runs in `cwd`. */
    launchDirectory?: string
  ) => Promise<AgentModelCatalogResolvedProbe>
}

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
