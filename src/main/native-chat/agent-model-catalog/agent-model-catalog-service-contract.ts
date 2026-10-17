import type {
  AgentSessionChoiceCatalog,
  AgentSessionModelCatalogResult
} from '../../../shared/agent-session-wire'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogLiveListing,
  AgentModelCatalogProbe,
  AgentModelCatalogStore
} from './agent-model-catalog-store'

export type AgentModelCatalogServiceDeps = {
  store: AgentModelCatalogStore
  getRecord: (sessionId: string) => AgentSessionRecord | undefined
  drivesRecord: (record: AgentSessionRecord) => boolean
  resolveAccountHome: (agent: string) => Promise<AgentSessionAccountHome>
  probes?: Readonly<Partial<Record<string, AgentModelCatalogProbe>>>
  listingNamesConfiguredModel?: ReadonlySet<string>
  recordWorkspacePath?: (record: AgentSessionRecord) => Promise<string | null>
  processScope?: (sessionId: string) => string | null
  agentReadsProjectModelConfig?: (agent: string) => boolean
  workspaceMayOverrideDefaultModel?: (input: {
    agent: string
    workspacePath: string
    accountHomePath: string | null
  }) => Promise<boolean>
  hasChatRecords?: (agent: string) => boolean
}

export type AgentModelCatalogRead = {
  agent: string
  sessionId?: string
  workspacePath?: string | null
  inSessionWorkspace?: true
  /** Legacy model-required display under the pinned account's normal launch directory. */
  accountDefault?: true
  waitForListing?: boolean
  savedOnly?: boolean
}

export type AgentModelCatalogService = {
  read: (params: AgentModelCatalogRead) => Promise<AgentSessionModelCatalogResult>
  retainedLiveModelIds: (sessionId: string, listing: AgentModelCatalogLiveListing) => string[]
  recordLiveListing: (sessionId: string, listing: AgentModelCatalogLiveListing) => void
  peek: (sessionId: string) => AgentModelCatalogEntry | null
  processCatalog: (sessionId: string) => AgentSessionChoiceCatalog | null
  prewarm: () => Promise<void>
  stop: () => void
  providerStarted: (
    record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location' | 'sessionId'>
  ) => void
}
