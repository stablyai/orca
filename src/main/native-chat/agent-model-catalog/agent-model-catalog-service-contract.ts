import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogLiveListing,
  AgentModelCatalogProbe
} from './agent-model-catalog-store'
import type { AgentModelCatalogWorkspaceDeps } from './agent-model-catalog-workspace'
export type AgentModelCatalogServiceDeps = AgentModelCatalogWorkspaceDeps & {
  getRecord: (sessionId: string) => AgentSessionRecord | undefined
  /** Unlaunchable records cannot authorize probing their account with a different host binary. */
  drivesRecord: (record: AgentSessionRecord) => boolean
  /** Share the launch resolver so recordless reads use the account a new chat would pin. */
  resolveAccountHome: (agent: string) => Promise<AgentSessionAccountHome>
  probes?: Readonly<Partial<Record<string, AgentModelCatalogProbe>>>
  listingNamesConfiguredModel?: ReadonlySet<string>
  /** False means project configuration cannot override the account default. */
  agentReadsProjectModelConfig?: (agent: string) => boolean
  hasChatRecords?: (agent: string) => boolean
}

export type AgentModelCatalogService = {
  peek: (sessionId: string, verifiedOnly?: boolean) => AgentModelCatalogEntry | null
  read: (params: {
    agent: string
    sessionId?: string
    /** null means the requested workspace is not a local directory. */
    workspacePath?: string | null
    inSessionWorkspace?: true
    /** Await missing-catalog discovery or reprobe of expired unavailability. */
    waitForListing?: boolean
    /** Return saved facts only; do not start, join or recheck discovery. */
    savedOnly?: boolean
    verifiedOnly?: boolean
    legacy?: boolean
    /** Display compatibility only, never launch/admission proof. */
    legacyOptionsDisplay?: true
  }) => Promise<AgentSessionModelCatalogResult>
  /** Validate only launch-injected rows against pinned account membership. */
  retainedLiveModelIds: (
    sessionId: string,
    listing: AgentModelCatalogLiveListing
  ) => Promise<string[]>
  recordLiveListing: (sessionId: string, listing: AgentModelCatalogLiveListing) => void
  /** Refresh missing/stale catalogs only for agents already used here. */
  prewarm: () => Promise<void>
  stop: () => void
  /** Successful chat startup makes held unavailability due for recheck. */
  providerStarted: (record: AgentSessionRecord) => void
}
