import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import type { BotLaunchTools } from '../../../bots/bot-launch-tools'
import type { StructuredAgentSessionHostDeps } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type { AgentSessionAccountKind } from '../../../../shared/agent-session/failures/agent-session-availability'
import type { StructuredAgentSessionTransportOverrides } from './structured-agent-session-transport-overrides'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { StructuredAttentionMobileDelivery } from '../lifecycle/structured-agent-session-mobile-attention'
import type {
  StructuredAgentCommand,
  StructuredAgentCommandSettings
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import type { NativeChatShellEnvironmentPolicy } from '../../../../shared/native-chat/settings/native-chat-shell-environment'
import type { ClaudeStructuredAuthPolicy } from '../../../claude-accounts/runtime-auth/claude-structured-auth-policy'
import type { RuntimeAgentAccountHomeResolver } from '../model-catalog/structured-agent-model-catalog-wiring'
import type { ClaudeCliFlagSupport } from '../../../claude/cli-capabilities/claude-cli-flag-support'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { LinkedSkills } from '../../../native-chat/native-chat-skill-roots'

export type StructuredAgentSessionRuntimeDeps = StructuredAgentSessionTransportOverrides & {
  /** Host state root. The record store and the journal database both hang off it. */
  stateDirectory: string
  legacySessionTabIds?: readonly string[]
  /** Execution host this runtime *is*. A record pinned elsewhere is not ours to
   *  probe and not ours to spawn for. */
  hostId: string
  /** Key id this host's claims are minted under. */
  claimKeyId: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCodexCommand?: (options?: {
    pathEnv?: string | null
    homePath?: string
  }) => StructuredAgentCommand
  resolveClaudeCommand?: (options?: {
    pathEnv?: string | null
    homePath?: string
  }) => StructuredAgentCommand
  /** Which version-gated flags a Claude CLI takes; absent never passes one. */
  claudeCliFlags?: ClaudeCliFlagSupport
  /** Gives each chat a scratch folder and the visuals skill that teaches it, and sweeps folders
   *  whose chat is gone. Wired by the real hosts only, so a test runtime never loads the bundled
   *  skill. */
  nativeChatVisuals?: {
    /** Read this host's preference when a chat starts a provider process. */
    isEnabled: () => boolean
  }
  /** Whether Pi chats refresh Orca's managed extensions in their agent dir. */
  piManagedExtensionsEnabled?: () => boolean
  /** This host's preference for agents' suggested next prompts, read when a chat starts one. */
  nativeChatPromptSuggestions?: () => boolean
  /** Required, and asserted at install time — saved Arguments must never be silently omitted. */
  resolveLaunchArgs: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  /** Required, and asserted at install time — an absent policy must not degrade to a guess. */
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  assertQueuedMessageAllowed?: StructuredAgentSessionHostDeps['assertQueuedMessageAllowed']
  usageLimitAutoContinue?: StructuredAgentSessionHostDeps['usageLimitAutoContinue']
  idleSweep?: StructuredAgentSessionHostDeps['idleSweep']
  /** What a chat saved before its agent had modes ran with; fills that chat's mode once. */
  resolveAgentFullAccess?: (agent: string) => boolean
  /** The user's per-agent environment overlay from settings, laid over every agent's base env. */
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
  /** The settings a per-agent Command override is read from, for the same agents. */
  resolveAgentCommandSettings?: () => StructuredAgentCommandSettings
  /** See `StructuredAgentLaunchSources.resolveInstructions`. */
  resolveSessionInstructions?: (
    record: AgentSessionRecord,
    launchDirectory: string,
    linkedSkills: string | null
  ) => Promise<string | null>
  /** See `StructuredAgentLaunchSources.readOnlySession`. */
  readOnlySession?: (sessionId: string) => ReadOnlySessionMode | null
  /** See `StructuredAgentLaunchSources.prepareLaunch`. */
  prepareSessionLaunch?: (record: AgentSessionRecord, launchDirectory: string) => Promise<void>
  /** See `StructuredAgentLaunchSources.resolveToolServers`. */
  resolveSessionToolServers?: (
    record: AgentSessionRecord,
    launchDirectory: string
  ) => Promise<BotLaunchTools>
  /** See `StructuredAgentLaunchSources.resolveLinkedSkills`. */
  resolveSessionLinkedSkills?: (record: AgentSessionRecord) => Promise<LinkedSkills>
  /** The chat's bot folder brought up to date, as a launch would load it, with no launch
   *  bookkeeping; rejects when it can't be. A resting chat's `/` probe loads the same root. */
  prepareSessionLinkedSkills?: (record: AgentSessionRecord) => Promise<LinkedSkills>
  /** See `StructuredAgentLaunchSources.reportLinkedSkills`. */
  reportSessionLinkedSkills?: (sessionId: string, linkedSkills: string | null) => void
  /** See `StructuredAgentSessionHostDeps.quietTurnEnd`. */
  quietTurnEnd?: StructuredAgentSessionHostDeps['quietTurnEnd']
  /** See `StructuredAgentSessionHostDeps.isBotHome`. */
  isBotHome?: StructuredAgentSessionHostDeps['isBotHome']
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Which login-shell variables Codex and Claude children inherit; absent inherits all. */
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  /** Where every failure the runtime and its host carry on past is reported. Required, so no path
   *  can drop one: the desktop and headless hosts both pass the trace-file logger. */
  logger: StructuredAgentSessionLogger
  /** Every structured-session status projection, for host-side reactions such as the first-work
   *  workspace rename that CLI agents get from their hooks. */
  onSessionStatusChanged?: StructuredAgentSessionHostDeps['onSessionStatusChanged']
  readWorkerDockPresence?: StructuredAgentSessionHostDeps['readWorkerDockPresence']
  conversationNaming?: StructuredAgentSessionHostDeps['conversationNaming']
  /** See `StructuredAgentSessionHostDeps.turnContext`. */
  turnContext?: StructuredAgentSessionHostDeps['turnContext']
  /** See `StructuredAgentSessionHostDeps.hasOpenDispatch`. */
  hasOpenDispatch?: StructuredAgentSessionHostDeps['hasOpenDispatch']
  /** See `StructuredAgentSessionHostDeps.queuedAgentMessageOwed`. */
  queuedAgentMessageOwed?: StructuredAgentSessionHostDeps['queuedAgentMessageOwed']
  resolveCodexAccountKind?: (home: string) => AgentSessionAccountKind | undefined
  /** Launch prep's sync for a probed home; see `CodexModelCatalogProbeDeps.prepareHome`. */
  prepareCodexCatalogProbeHome?: (homePath: string) => void | Promise<void>
  /** See `StructuredAgentSessionHostDeps.onMessageAdmitted`. */
  onMessageAdmitted?: StructuredAgentSessionHostDeps['onMessageAdmitted']
  /** See `StructuredAgentSessionHostDeps.onSessionTabHidden`. */
  onSessionTabHidden?: StructuredAgentSessionHostDeps['onSessionTabHidden']
  assertNoTerminalWriter?: StructuredAgentSessionHostDeps['assertNoTerminalWriter']
  /** Host-owned phone delivery and reconciliation from the current journal projection. */
  attentionDelivery?: StructuredAttentionMobileDelivery
  /** Every live turn completion and pending prompt, with the host's status at that edge. */
  createTurnAttention?: () => {
    onTurnAttention: (
      event: AgentSessionTurnCompletionEvent,
      readStatus: (sessionId: string) => AgentSessionStatusSummary | undefined
    ) => void
    start: () => void
    stop: () => void
  }
  /** The account home a structured launch would pin right now, for catalog
   *  reads with no session record. Absent disables the catalog surface. */
  resolveAgentAccountHome?: RuntimeAgentAccountHomeResolver
  /** See `StructuredAgentSessionHostDeps.launchAccountHome`. */
  launchAccountHome?: StructuredAgentSessionHostDeps['launchAccountHome']
  /** See `StructuredAgentSessionHostDeps.launchTools`. */
  launchTools?: StructuredAgentSessionHostDeps['launchTools']
  /** That account home, prepared for a start of `record` in `launchDirectory`. */
  prepareLaunchAccountHome?: (
    record: AgentSessionRecord,
    launchDirectory: string
  ) => Promise<AgentSessionAccountHome | null>
} & Pick<StructuredAgentSessionHostDeps, 'onRequestFailure' | 'onIdleProviderDeath' | 'statusSink'>
