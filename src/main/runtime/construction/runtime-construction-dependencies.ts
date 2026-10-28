import type { AiVaultSessionSources } from '../../ai-vault/cached-session-list'
import type { CliWriterObservation } from '../../agent-hooks/server/cli-writer-observation'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import type { PrepareClaudeAuth } from '../../ipc/pty/host-env/types'
import type {
  RuntimeTerminalAgentStatusEvent,
  RuntimeTerminalProgramStatusFacetEvent
} from '../runtime-terminal-contracts'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'
import type { ClaudeTerminalEvidence } from '../../../shared/claude-terminal-interrupt'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { StructuredAgentSessionStatusSink } from '../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { ObservedAgentStatusPaneIdentity } from '../../ipc/agent-status-ipc-boundary'
import type { AgentHookAuthorityAttestation } from '../../agent-hooks/server'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault-resume-preparation'
import type { RuntimeDesktopWindowStatus } from '../../../shared/runtime-types'
import type { AgentSessionClaimSigner } from '../agent-session/ownership/agent-session-claim-identity'
import type { OrchestrationEnvironmentTransport } from '../orchestration/environment-transport'
import type { WorkspaceSleepPlatform } from '../workspaces/workspace-sleep-platform'
import type { SessionSearchSettingsApply } from '../runtime-session-search-settings'

export type RuntimeConstructionDependencies = {
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
  structuredAgentStatusSink?: StructuredAgentSessionStatusSink
  readObservedAgentStatusPaneIdentity?: (paneKey: string) => ObservedAgentStatusPaneIdentity
  getAgentProviderSessionSnapshot?: () => AgentStatusIpcPayload[]
  getAgentProviderSessionRowsForPane?: (paneKey: string) => AgentStatusIpcPayload[]
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
  reconcileAgentStatusForEndedProcess?: (paneKeys: Iterable<string>) => void
  /** A worker attached to these panes; an exit the hook store proved before then is not its own. */
  forgetHookAgentExit?: (paneKeys: Iterable<string>) => void
  dropAgentStatusForRemovedWorktree?: (worktreeId: string, host?: ExecutionHostScope) => void
  canRecoverPersistentLocalPtys?: () => boolean
  getPairedDeviceName?: (pairedDeviceId: string) => string | null
  getProjectOwnershipCatalog?: AiVaultSessionSources['getProjectOwnershipCatalog']
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
  prepareCodexCatalogProbeHome?: (homePath: string) => void
  buildAgentHookPtyEnv?: () => Record<string, string>
  getDesktopWindowStatus?: () => RuntimeDesktopWindowStatus
  agentSessionClaimSigner?: AgentSessionClaimSigner
  skillTransactionRecovery?: Promise<unknown>
  applySessionSearchSettings?: SessionSearchSettingsApply
  orchestrationEnvironmentTransport?: OrchestrationEnvironmentTransport
  workspaceSleepPlatform?: WorkspaceSleepPlatform
}

export type RuntimeConstructionBindings = Required<RuntimeConstructionDependencies>
