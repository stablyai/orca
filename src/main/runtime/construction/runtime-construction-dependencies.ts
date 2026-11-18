import type { PairedDeviceAccountLookup } from '../rpc/server/pairing/device-entry'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CliWriterObservation } from '../../agent-hooks/server/cli-writer-observation'
import type { ExecutionHostScope } from '../../../shared/execution-host/execution-host'
import type { IPtyProvider } from '../../providers/pty/provider-contract'
import type { PrepareClaudeAuth } from '../../ipc/pty/host-env/types'
import type {
  RuntimeTerminalAgentStatusEvent,
  RuntimeTerminalProgramStatusFacetEvent
} from '../terminal/output/terminal-agent-status-events'
import type { TerminalSideEffectBatch } from '../../../shared/terminal/output/terminal-side-effect-facts'
import type { ClaudeTerminalEvidence } from '../../../shared/agent-hook-listener/providers/claude/lifecycle/claude-terminal-interrupt'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { StructuredAgentSessionStatusSink } from '../../native-chat/agent-session-wire/observations/structured-agent-session-status-ownership'
import type { ObservedAgentStatusPaneIdentity } from '../../ipc/agent-hooks/agent-status-ipc-boundary'
import type { AgentHookAuthorityAttestation } from '../../agent-hooks/server/server-types'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type { RuntimeDesktopWindowStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { AgentSessionClaimSigner } from '../agent-session/ownership/agent-session-claim-identity'
import type { OrchestrationEnvironmentTransport } from '../orchestration/federation/environment-transport'
import type { WorkspaceSleepPlatform } from '../workspaces/sleep/workspace-sleep-platform'
import type { SessionSearchSettingsApply } from '../integrations/ai-vault/runtime-session-search-settings'

export type RuntimeConstructionDependencies = {
  /** A host that opened the saved-chat store before construction passes the ids it used. */
  legacyStructuredSessionTabIds?: readonly string[]
  getSetupTerminalTitle?: () => string
  getLocalProvider?: () => IPtyProvider
  prepareClaudeAuth?: PrepareClaudeAuth
  onPtyStopped?: (ptyId: string) => void
  onTerminalAgentStatus?: (event: RuntimeTerminalAgentStatusEvent) => void
  onTerminalProgramStatusFacet?: (event: RuntimeTerminalProgramStatusFacetEvent) => void
  onTerminalSideEffects?: (batch: TerminalSideEffectBatch) => void
  onClaudeTerminalEvidence?: (paneKey: string, evidence: ClaudeTerminalEvidence) => void
  getAgentStatusSnapshot?: () => AgentStatusIpcPayload[]
  getAgentStatusSnapshotForPane?: (paneKey: string) => AgentStatusIpcPayload[]
  getPublicAgentStatusSnapshotForPane?: (
    paneKey: string,
    terminalHandle?: string | null
  ) => AgentStatusIpcPayload[]
  structuredAgentStatusSink?: StructuredAgentSessionStatusSink
  readObservedAgentStatusPaneIdentity?: (paneKey: string) => ObservedAgentStatusPaneIdentity
  getAgentProviderSessionSnapshot?: (tabId?: string) => AgentStatusIpcPayload[]
  getAgentProviderSessionRowsForSession?: (
    agent: string,
    session: AgentProviderSessionMetadata
  ) => AgentStatusIpcPayload[]
  getAgentProviderSessionRowsForPane?: (
    paneKey: string,
    terminalHandle?: string | null
  ) => AgentStatusIpcPayload[]
  getAcceptedAgentReply?: (paneKey: string, leadTurnKey: number) => string | undefined
  subscribeAgentStatusRowChanges?: (listener: (paneKey: string) => void) => () => void
  subscribeAgentProviderSessionChanges?: (
    listener: (sessions: readonly { paneKey: string; sessionId: string }[]) => void
  ) => () => void
  attestAgentHookCompatibilityAuthority?: (candidate: {
    paneKey: string
    launchTokenHash: string
    connectionId: string | null
    terminalProvenance: 'current_runtime' | 'restored'
  }) => AgentHookAuthorityAttestation | null
  retireAgentHookCompatibilityAuthority?: (paneKey: string) => void
  readHookCliWriterObservation?: (row: AgentStatusIpcPayload) => CliWriterObservation | null
  /** `exitedSince`: also answer `exited` for an exit the hook store proved at or after it. */
  checkHookAgentPresence?: (
    paneKey: string,
    exitedSince?: number
  ) => Promise<'live' | 'unverifiable' | 'exited' | null>
  reconcileAgentStatusForEndedProcess?: (
    paneKeys: Iterable<string>,
    sleep?: { ptyId: string; incarnationId?: string }
  ) => void
  /** A worker attached to these panes; an exit the hook store proved before then is not its own. */
  forgetHookAgentExit?: (paneKeys: Iterable<string>) => void
  dropAgentStatusForRemovedWorktree?: (worktreeId: string, host?: ExecutionHostScope) => void
  canRecoverPersistentLocalPtys?: () => boolean
  getPairedDeviceName?: (pairedDeviceId: string) => string | null
  /** The Orca account a paired device says it is signed in to (a phone: its desktop's), with its
   *  computer; a desktop's comes from the sending connection's claim when one is given. */
  getPairedDeviceAccount?: PairedDeviceAccountLookup
  getAdditionalAiVaultCodexHomePaths?: () => readonly string[]
  prepareAiVaultSessionResume?: (
    args: AiVaultPrepareSessionResumeArgs
  ) => Promise<AiVaultPrepareSessionResumeResult>
  prepareCodexStructuredLaunch?: (input: {
    launchEnv: NodeJS.ProcessEnv
  }) => string | null | Promise<string | null>
  resolveCodexStructuredLaunchHome?: (input: {
    launchEnv: NodeJS.ProcessEnv
  }) => string | null | Promise<string | null>
  prepareCodexCatalogProbeHome?: (homePath: string) => void | Promise<void>
  buildAgentHookPtyEnv?: () => Record<string, string>
  getDesktopWindowStatus?: () => RuntimeDesktopWindowStatus
  /** Live headless-model depth; a host with no renderer to reveal from needs only its PTY provider's live window. */
  headlessTerminalScrollbackRows?: number
  agentSessionClaimSigner?: AgentSessionClaimSigner
  skillTransactionRecovery?: Promise<unknown>
  applySessionSearchSettings?: SessionSearchSettingsApply
  orchestrationEnvironmentTransport?: OrchestrationEnvironmentTransport
  workspaceSleepPlatform?: WorkspaceSleepPlatform
  /** The Orca profile whose store this runtime serves; fixed for the process, unlike the active one. */
  servedOrcaProfileId?: string
}

export type RuntimeConstructionBindings = Required<RuntimeConstructionDependencies>
