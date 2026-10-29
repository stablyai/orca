import type { StructuredAgentSessionHostDeps } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { StructuredAgentSessionTransportOverrides } from './structured-agent-session-transport-overrides'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { StructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import type { NativeChatShellEnvironmentPolicy } from '../../shared/native-chat/native-chat-shell-environment'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import type { RuntimeAgentAccountHomeResolver } from './structured-agent-model-catalog-wiring'
import type { ClaudeCliFlagSupport } from '../claude/claude-cli-flag-support'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export type StructuredAgentSessionRuntimeDeps = StructuredAgentSessionTransportOverrides & {
  /** Host state root. The record store and the journal database both hang off it. */
  stateDirectory: string
  /** Execution host this runtime *is*. A record pinned elsewhere is not ours to
   *  probe and not ours to spawn for. */
  hostId: string
  /** Key id this host's claims are minted under. */
  claimKeyId: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCodexCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  resolveClaudeCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Which version-gated flags a Claude CLI takes; absent never passes one. */
  claudeCliFlags?: ClaudeCliFlagSupport
  /** Gives each chat a scratch folder and the visuals skill that teaches it, and sweeps folders
   *  whose chat is gone. Wired by the real hosts only, so a test runtime never loads the bundled
   *  skill. */
  nativeChatVisuals?: {
    /** Read this host's preference when a chat starts a provider process. */
    isEnabled: () => boolean
  }
  /** Required, and asserted at install time — saved Arguments must never be silently omitted. */
  resolveLaunchArgs: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  /** Required, and asserted at install time — an absent policy must not degrade to a guess. */
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** What a chat saved before its agent had modes ran with; fills that chat's mode once. */
  resolveAgentFullAccess?: (agent: string) => boolean
  /** The user's per-agent environment overlay from settings, laid over every agent's base env. */
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
  /** The settings a per-agent Command override is read from, for the same agents. */
  resolveAgentCommandSettings?: () => StructuredAgentCommandSettings
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Which login-shell variables Codex and Claude children inherit; absent inherits all. */
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  /** Where every failure the runtime and its host carry on past is reported. Required, so no path
   *  can drop one: the desktop and headless hosts both pass the trace-file logger. */
  logger: StructuredAgentSessionLogger
  /** Every structured-session status projection, for host-side reactions such as the first-work
   *  workspace rename that CLI agents get from their hooks. */
  onSessionStatusChanged?: StructuredAgentSessionHostDeps['onSessionStatusChanged']
  conversationNaming?: StructuredAgentSessionHostDeps['conversationNaming']
  /** See `StructuredAgentSessionHostDeps.hasOpenDispatch`. */
  hasOpenDispatch?: StructuredAgentSessionHostDeps['hasOpenDispatch']
  resolveCodexAccountKind?: (home: string) => AgentSessionAccountKind | undefined
  /** Launch prep's sync for a probed home; see `CodexModelCatalogProbeDeps.prepareHome`. */
  prepareCodexCatalogProbeHome?: (homePath: string) => void
  /** See `StructuredAgentSessionHostDeps.onSessionTabHidden`. */
  onSessionTabHidden?: StructuredAgentSessionHostDeps['onSessionTabHidden']
  assertNoTerminalWriter?: StructuredAgentSessionHostDeps['assertNoTerminalWriter']
  /** Host-owned phone delivery and reconciliation from the current journal projection. */
  attentionDelivery?: StructuredAttentionMobileDelivery
  /** The account home a structured launch would pin right now, for catalog
   *  reads with no session record. Absent disables the catalog surface. */
  resolveAgentAccountHome?: RuntimeAgentAccountHomeResolver
} & Pick<StructuredAgentSessionHostDeps, 'onRequestFailure' | 'statusSink'>
