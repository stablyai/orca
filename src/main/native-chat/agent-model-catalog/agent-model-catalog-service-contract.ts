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
  /** Whether this build can start the record's agent as the record pins it; a record it cannot
   *  names no account a probe may start that agent's CLI under. */
  drivesRecord: (record: AgentSessionRecord) => boolean
  /** The account home a structured launch for this agent would pin right now —
   *  the SAME resolver the create path fills `record.accountHome` with, so a
   *  record-less read can never answer from another account's listing. */
  resolveAccountHome: (agent: string) => Promise<AgentSessionAccountHome>
  /** Session-less listers, one per agent that has one on this host. */
  probes?: Readonly<Partial<Record<string, AgentModelCatalogProbe>>>
  /** Agents whose listing marks the model the account is configured to run as its default. */
  listingNamesConfiguredModel?: ReadonlySet<string>
  /** False for an agent whose model no project config can pick; its default holds everywhere. */
  agentReadsProjectModelConfig?: (agent: string) => boolean
  /** Whether this host keeps any chat of the agent; with a saved catalog, what marks it in use. */
  hasChatRecords?: (agent: string) => boolean
}

export type AgentModelCatalogService = {
  peek: (sessionId: string, verifiedOnly?: boolean) => AgentModelCatalogEntry | null
  read: (params: {
    agent: string
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
  }) => Promise<AgentSessionModelCatalogResult>
  /** Incoming listing ids, checking only a launch-added row against the pinned account. */
  retainedLiveModelIds: (
    sessionId: string,
    listing: AgentModelCatalogLiveListing
  ) => Promise<string[]>
  /** Saves a session's listing and newly learned menus so the next chat starts warm. */
  recordLiveListing: (sessionId: string, listing: AgentModelCatalogLiveListing) => void
  /** Lists, in the background, every agent the user has used here (a saved catalog or a chat)
   *  whose catalog for the account a new chat would pin is missing or old, so a picker never meets
   *  a cold catalog. Resolves once those listings settle. */
  prewarm: () => Promise<void>
  /** The host is going away: start no listing, and stop the ones running. */
  stop: () => void
  /** A chat under this record's account proved its start: a held reason is re-checked sooner. */
  providerStarted: (record: AgentSessionRecord) => void
}
