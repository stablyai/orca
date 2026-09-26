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
import type { RuntimeTerminalSend } from '../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import type { WorkerTerminalHostScope } from './orchestration/worker-terminal-process-liveness'

export type TerminalCreateOptions = {
  command?: string
  /**
   * Windows shell to spawn AS the PTY process, instead of the host default shell.
   *
   * Distinct from `command`, which is typed into whatever shell the host spawns: a caller asking
   * for cmd or PowerShell through `command` gets it as a CHILD of the default shell, so the
   * terminal's own process is still the default shell and leaving that child lands back on a
   * prompt the caller never asked for.
   */
  shellOverride?: string
  claudeAgentTeamsSourceCommand?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  startupAgent?: TuiAgent
  /**
   * Initial text folded into `startupAgent`'s launch command, for an agent whose CLI takes a prompt
   * argument. Not a general prompt channel: an agent that takes its text only after start has no
   * launch command to carry it, and a caller that sets this for one is refused rather than having
   * the prompt silently dropped. Post-start delivery belongs to whoever owns the live PTY.
   */
  startupPrompt?: string
  /**
   * Replaces the Settings launch arguments for this `startupAgent` only; `null` means none at all.
   *
   * Not part of `callerSuppliedLaunch`: that guard refuses a caller that brought its own *command*,
   * which would contradict the agent the runtime is resolving. Arguments are an input to the plan
   * the runtime still builds, so overriding them does not take the launch away from it.
   */
  agentArgs?: string | null
  launchPreferences?: AgentLaunchPreferences
  terminalKittyKeyboardProtocol?: boolean
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
  /** Refuse, rather than attach, when `tabId`/`leafId` name a pane whose PTY is already live. */
  requireFreshPane?: boolean
  sessionId?: string
  isNewSession?: boolean
  preAllocatedHandle?: string
  persistHostSessionBinding?: boolean
  agentSessionClaim?: AgentSessionExecutionClaim
  agentSessionCreateOperationId?: string
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
  /** The pane's terminal handle, when it is bound to one. Stamped on the stored row so a
   *  reader can rejoin it to the terminal after the pane key moved. */
  terminalHandle?: string
  payload: ParsedAgentStatusPayload
}

export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  'payload' | 'updatedAt' | 'evidenceObservedAt' | 'stateStartedAt' | 'worktreeId'
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
  /** Retires the repeated visible-screen probe armed for this waiter; null when not probing. */
  cancelVisibleProbe: (() => void) | null
  abortCleanup: (() => void) | null
}

/** How a provider-held screen should be fetched when runtime bytes are absent. */
export type RuntimeProviderSnapshotReadOptions = {
  timeoutMs?: number
  retireOnTimeout?: boolean
  visibleScreenOnly?: boolean
}

/** Agent-prompt writes add the correlation inputs a queued-acceptance receipt needs. */
export type RuntimeAgentPromptWriteOptions = RuntimeTerminalWriteOptions & {
  /** Raw prompt text for submit scheduling; not written, only used for line-aware delays. */
  promptForSchedule?: string
  /** See buildAgentPromptPasteBytes. */
  leadLine?: string
  /** Return an accepted receipt as soon as input lands, instead of waiting for the turn. */
  acceptQueued?: boolean
  observationTimeoutMs?: number
  requestId?: string
  onInputAccepted?: (send: RuntimeTerminalSend) => void
}
