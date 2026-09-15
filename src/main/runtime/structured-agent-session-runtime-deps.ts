import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { CodexStructuredSessionAdapterDeps } from '../codex/codex-structured-session-adapter'
import type { ClaudeStructuredSessionAdapterDeps } from '../claude/claude-structured-session-adapter'
import type { StructuredAgentSessionHostDeps } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import type { stopOrphanAgentSessionChildren } from './agent-session-orphan-child-reaper'

export type StructuredAgentSessionRuntimeDeps = {
  /** Host state root. The record store and the journal tree both hang off it. */
  stateDirectory: string
  /** Execution host this runtime *is*. A record pinned elsewhere is not ours to
   *  probe and not ours to spawn for. */
  hostId: string
  /** Key id this host's claims are minted under. */
  claimKeyId: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCodexCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  resolveClaudeCommand?: () => string
  /** Provider transports are overridden only to drive the runtime against scripted children. */
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  /** Scripted app-servers carry fake pids the real start-time read cannot answer for. */
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  resolveLaunchArgs?: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnvOverlay?: () => Promise<Record<string, string>> | Record<string, string>
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** Required, and asserted at install time — an absent policy must not degrade to a guess. */
  resolveClaudeAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** Raw settings getter; the reader that fails closed around it is built here, in checked code. */
  getClaudeManagedAccountGateSettings?: () => ClaudeManagedAccountGateSettings
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
  onError?: (input: { scope: string; error: unknown }) => void
  /** Every structured-session status projection, for host-side reactions such as the first-work
   *  workspace rename that CLI agents get from their hooks. */
  onSessionStatusChanged?: StructuredAgentSessionHostDeps['onSessionStatusChanged']
  /** The agent-status store; see `StructuredAgentSessionHostDeps.statusSink`. */
  statusSink?: StructuredAgentSessionHostDeps['statusSink']
  handoffTransport?: StructuredAgentSessionHandoffTransport
  reapOrphanChildren?: typeof stopOrphanAgentSessionChildren
}
