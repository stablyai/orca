import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type {
  AgentLaunchPreferences,
  AgentSessionExecutionClaim,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { OrchestrationCompatibilityHostStamp } from '../../shared/orchestration-compatibility-evidence'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import type {
  RuntimeTerminalPresentation,
  RuntimeTerminalWait,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import type { WorkerTerminalHostScope } from './orchestration/worker-terminal-process-liveness'

export type TerminalCreateOptions = {
  command?: string
  claudeAgentTeamsSourceCommand?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  startupAgent?: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  viewMode?: 'terminal' | 'chat'
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  telemetry?: WorktreeStartupLaunch['telemetry']
  title?: string
  focus?: boolean
  rendererBacked?: boolean
  activate?: boolean
  presentation?: RuntimeTerminalPresentation
  surfaceOwner?: false
  tabId?: string
  leafId?: string
  sessionId?: string
  isNewSession?: boolean
  preAllocatedHandle?: string
  persistHostSessionBinding?: boolean
  agentSessionClaim?: AgentSessionExecutionClaim
  agentSessionCreateOperationId?: string
  structuredAgentSessionId?: string
  signal?: AbortSignal
  onPtySpawnCommitted?: () => void
  deferMobileSessionPublish?: boolean
}

/** Identity a fenced spawn can be re-found by in the execution host's own inventory. */
export type AgentSessionCreateReclaimIdentity = {
  worktreeId: string
  connectionId: string | null
  terminalHandle: string
}

export type AgentSessionCreateOperation = {
  fingerprint: string
  promise: Promise<RuntimeCreateAgentSessionResult>
  // Why: a lost pty.spawn response leaves the host holding a live PTY the client
  // never named; this is the name it was launched under, so a replay can adopt it.
  reclaim: { identity?: AgentSessionCreateReclaimIdentity }
}

export type PtyForegroundAgentRefresh = {
  promise: Promise<boolean>
  startedAfterTitleObservation: number
  requestedAfterTitleObservation: number
}

export type PtyForegroundProcessRead = {
  controller: RuntimePtyController
  process: string | null
  available: boolean
}

export type PtyForegroundProcessReadEntry = {
  controller: RuntimePtyController
  startedAfterTitleObservation: number
  promise: Promise<PtyForegroundProcessRead>
}

export type RuntimeTerminalAgentStatusEvent = {
  ptyId: string
  source: 'mounted-leaf' | 'pty-record'
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
  payload: ParsedAgentStatusPayload
}

export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  'payload' | 'updatedAt' | 'stateStartedAt' | 'worktreeId'
>

export type RuntimePtyDataAdmission = Readonly<{
  sequence: number
  completion: Promise<void>
}>

export type TerminalHandleRecord = {
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
}

export type OrchestrationCompatibilityTerminalAuthority = {
  runtimeId: string
  terminalHandle: string
  ptyId: string
  worktreeId: string
  processIncarnation: string | null
  paneKey: string | null
  launchTokenHash: string | null
  hostScope: WorkerTerminalHostScope
}

export type OrchestrationCompatibilityCallerAuthority = Readonly<{
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
  paneKey: string
  terminalHandle: string
  processIncarnation: string
  launchTokenHash: string
}>

export type RestoredOrchestrationAuthorityReceipt = Readonly<{
  ptyId: string
  worktreeId: string
  terminalHandle: string
  paneKey: string
  processIncarnation: string
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
}>

export type OrchestrationCompatibilitySshAttachmentAuthority = Extract<
  OrchestrationCompatibilityHostStamp,
  { kind: 'ssh' }
>

export type TerminalWaiter = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  resolve: (result: RuntimeTerminalWait) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout | null
  /** Retires this waiter from the shared idle-poll sweep; null when not polling. */
  cancelIdlePoll: (() => void) | null
  abortCleanup: (() => void) | null
}

/** How a provider-held screen should be fetched when runtime bytes are absent. */
export type RuntimeProviderSnapshotReadOptions = {
  timeoutMs?: number
  retireOnTimeout?: boolean
  visibleScreenOnly?: boolean
}
