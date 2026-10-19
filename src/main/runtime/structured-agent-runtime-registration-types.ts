import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { applyStructuredCodexWorkspaceTrust } from '../agent-workspace-trust-spawn'
import type { StructuredAgentCliConversations } from '../native-chat/structured-agent-cli-conversations'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { AgentModelCatalogDiscovery } from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import type { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import type {
  StructuredClaudeAccountHomeDeps,
  StructuredCodexAccountHomeDeps
} from './structured-agent-account-home'

/** What an agent's adapter is built from: the open store and the runtime around it. */
export type StructuredAgentAdapterContext = {
  deps: StructuredAgentSessionRuntimeDeps
  store: AgentSessionRecordStore
  journalDatabase: JournalHostDatabase
  environment: ReturnType<typeof createStructuredAgentEnvironmentResolvers>
  /** Hands the host an exit or other lifecycle event the agent observed. */
  deliverLifecycle: (event: StructuredAgentSessionLifecycleEvent) => void
  followUps: ReturnType<typeof createStructuredAgentSessionDispatchFollowUps>
  /** Null until the host is built: the adapters are built first. */
  host: () => StructuredAgentSessionHost | null
}

export type StructuredAgentRuntimeAdapter = StructuredAgentSessionAdapter & {
  closeAll: () => Promise<void>
  /** Resolves once exits the agent observed have been published; absent when it publishes at once. */
  drainObservedExits?: () => Promise<void>
}

/** Which account home a chat of an agent pins, asked on the host that runs it. */
export type StructuredAgentAccountHomeRequest = {
  launchEnv: NodeJS.ProcessEnv
  /** Where the chat runs; null for a read with no workspace (the model catalog). */
  location: AgentSessionExecutionLocation | null
  /** A `read` has no side effects: it syncs no home, starts no bridge, clears no selection. */
  purpose: 'launch' | 'read'
  /** The launch's workspace directory on this host; a read has none. */
  workspacePath: (() => Promise<string>) | null
}

/** What resolving an account may ask of the runtime around it. */
export type StructuredAgentAccountHomeServices = {
  getClaudeConfigDirectory: StructuredClaudeAccountHomeDeps['getClaudeConfigDirectory']
  /** Codex's home for a launch, prepared for it; and the same answer with no side effects. */
  prepareCodexLaunchHome: StructuredCodexAccountHomeDeps['resolveLaunchHome']
  readCodexLaunchHome: StructuredCodexAccountHomeDeps['resolveLaunchHome']
  workspaceTrustSettings: () => Parameters<typeof applyStructuredCodexWorkspaceTrust>[0]['settings']
  /** Orca's data folder on this host, where an agent's chats may keep an account of their own. */
  stateDirectory: string
}

/** What a catalog probe is built from: the same runtime resolvers its sessions launch through. */
export type StructuredAgentModelCatalogContext = Pick<
  StructuredAgentAdapterContext,
  'deps' | 'environment'
>

export type StructuredAgentLaunchCheck = {
  /** The binary and env a launch from `env` runs; throws the launch's own pre-spawn refusal. */
  resolveLaunch: (
    env: Record<string, string>,
    commandSettings: StructuredAgentCommandSettings
  ) => { command: string; env: Record<string, string> }
  /** Whether a release that binary prints on `--version` runs a structured chat. */
  supportsVersion: (version: string) => boolean
}

export type StructuredAgentRuntimeMetadata = StructuredAgentCliConversations & {
  definition: StructuredAgentDefinition
  /** How this agent's models are listed before any session of it runs. Required: an agent that
   *  cannot list says so, rather than being left out of the shared catalog. */
  modelCatalog: (context: StructuredAgentModelCatalogContext) => AgentModelCatalogDiscovery
  /** Whether this agent's chats can run at `location`; answered without building the host. */
  supportsLocation: (location: AgentSessionExecutionLocation) => boolean
  /** How create asks whether the agent installed on this host runs a structured chat, with the
   *  environment a launch starts from; absent when the location alone decides. */
  launchCheck?: StructuredAgentLaunchCheck
  /** The account a chat of this agent pins; see `StructuredAgentAccountHomeRequest`. */
  resolveAccountHome: (
    request: StructuredAgentAccountHomeRequest,
    services: StructuredAgentAccountHomeServices
  ) => Promise<AgentSessionAccountHome>
}

export type StructuredAgentRuntimeRegistration = StructuredAgentRuntimeMetadata & {
  createAdapter: (context: StructuredAgentAdapterContext) => StructuredAgentRuntimeAdapter
}
