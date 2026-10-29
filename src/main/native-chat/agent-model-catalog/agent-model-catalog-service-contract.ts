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
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type {
  AgentModelCatalogWorkspaceDeps,
  AgentModelCatalogRecord
} from './agent-model-catalog-workspace'
export type AgentModelCatalogServiceDeps = AgentModelCatalogWorkspaceDeps & {
  getConversation: (sessionId: string) => AgentSessionConversationView | undefined
  getRecord: (sessionId: string) => AgentSessionRecord | undefined
  /** Unlaunchable records cannot authorize probing their account with a different host binary. */
  drivesRecord: (record: AgentModelCatalogRecord) => boolean
  /** Share the launch resolver so recordless reads use the account a new chat would pin. */
  resolveAccountHome: (agent: string) => Promise<AgentSessionAccountHome>
  probes?: Readonly<Partial<Record<string, AgentModelCatalogProbe>>>
  listingNamesConfiguredModel?: ReadonlySet<string>
  /** False means project configuration cannot override the account default. */
  agentReadsProjectModelConfig?: (agent: string) => boolean
  hasChatRecords?: (agent: string) => boolean
}

export type AgentModelCatalogSource = (() => boolean) & {
  bind?: (record: AgentSessionRecord) => void
  release?: () => void
}

export type AgentModelCatalogService = {
  snapshot: (params: AgentModelCatalogReadParams) => AgentSessionModelCatalogResult
  demand: (params: AgentModelCatalogReadParams) => Promise<void>
  /** Explicitly resolves saved scope without listing or refreshing the environment. */
  prepareSaved: (params: AgentModelCatalogReadParams) => Promise<AgentSessionModelCatalogResult>
  captureSource: (
    record: Pick<AgentSessionRecord, 'provider' | 'location'>
  ) => AgentModelCatalogSource
  retireContext: (workspaceId?: string) => void
  peek: (sessionId: string, verifiedOnly?: boolean) => AgentModelCatalogEntry | null
  read: (params: AgentModelCatalogReadParams) => Promise<AgentSessionModelCatalogResult>
  /** Saves a session's listing and newly learned menus so the next chat starts warm. */
  recordLiveListing: (
    sessionId: string,
    listing: AgentModelCatalogLiveListing,
    source?: () => boolean
  ) => void
  /** Lists, in the background, every agent the user has used here (a saved catalog or a chat)
   *  whose catalog for the account a new chat would pin is missing or old, so a picker never meets
   *  a cold catalog. Resolves once those listings settle. */
  prewarm: () => Promise<void>
  stop: () => void
  /** A chat under this record's account proved its start: a held reason is re-checked sooner. */
  providerStarted: (record: AgentSessionRecord, source?: () => boolean) => void
}

export type AgentModelCatalogReadParams = {
  agent: string
  /** Original explicit operation budget, shared with compatibility saved-scope continuation. */
  deadline?: number
  /** Internal selector resolution; never part of the wire contract. */
  workspace?: {
    selector: string
    identity: () => unknown
    resolve: () => Promise<string | null | { path: string | null; identity: unknown }>
  }
  sessionId?: string
  /** Where a new chat would run; null when one was named but is not a local directory. */
  workspacePath?: string | null
  /** Answer for the folder the named session runs in, as its new-chat read did. */
  inSessionWorkspace?: true
  /** With no entry yet, answer from the listing this read starts or joins instead of `unknown`;
   *  with a held reason past its TTL, from the probe re-checking it. */
  waitForListing?: boolean
  /** Answer only from the saved entry and held reason; start, join or re-check no listing. */
  savedOnly?: boolean
  verifiedOnly?: boolean
  legacy?: boolean
  /** Old options readers need account-default presentation, never launch or admission proof. */
  legacyOptionsDisplay?: true
}
