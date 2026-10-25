import type { ProgramStatusFacet } from '../../shared/program-status/facet'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import type { AgentLaunchTabViewerRule } from '../../shared/agent-launch-tab-publication'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type {
  AgentLaunchPreferences,
  AgentSessionExecutionClaim,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
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
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import type { WorkerTerminalHostScope } from '../../shared/worker-terminal-host-scope'

export type TerminalCreateOptions = {
  command?: string
  /** Spawn Windows shell as the PTY process; selecting it through command creates only a child and later returns to the unwanted default shell. */
  shellOverride?: string
  claudeAgentTeamsSourceCommand?: string
  cwd?: string
  /** The caller's own measured pane size; wins over the group's measured size and the 120x40 fallback. */
  initialSize?: { cols: number; rows: number }
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  startupAgent?: TuiAgent
  /** Offer initial text only to compatible startupAgent launch commands; otherwise refuse instead of silently dropping it.
   * Typed-line carry gates delivery; onStartupPromptCarry reports clean launches whose later delivery belongs to the live PTY owner. */
  startupPrompt?: string
  /** TEMPORARY createAgentSession parity: draft populates the unsent composer via flag/env and bypasses typed-line carry; remove with unified delivery policy. */
  startupPromptDelivery?: 'auto-submit' | 'draft'
  /** TEMPORARY createAgentSession parity: force-line carries any size or launches clean for post-start-only agents; remove when uncarried prompts gain later delivery. */
  startupPromptCarry?: 'force-line'
  /** Main-internal: whether `startupPrompt` rode the launch command. Called once the plan is built. */
  onStartupPromptCarry?: (carried: boolean) => void
  /** Override Settings arguments for this agent (null means none); plan input is not a caller-supplied command and does not take launch ownership. */
  agentArgs?: string | null
  /** Main-internal: Orca, not a user, types into this `startupAgent` once it starts. */
  suppressStartupUpdatePrompt?: boolean
  /** Host-only runtime fact used to quote this launch; spawn must take its shell from that same fact, never client input. */
  launchRuntime?: AgentLaunchRuntime
  /** Account routing env merged over `startupAgent`'s plan env; an input to that plan, like
   *  `agentArgs`, so not part of `callerSuppliedLaunch`. */
  accountEnv?: Record<string, string>
  launchPreferences?: AgentLaunchPreferences
  terminalKittyKeyboardProtocol?: boolean
  terminalImageViewerSupported?: boolean
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  viewMode?: 'terminal' | 'chat'
  /** The tab group a background create joins; defaults to the first group. */
  targetGroupId?: string
  /** Main-internal placement anchor; removed before PTY dispatch. */
  afterTabId?: string
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  telemetry?: WorktreeStartupLaunch['telemetry']
  /** Attribute host-built startupAgent launches by surface; missing/unknown surface becomes unknown. Ignore without startupAgent. */
  launchSource?: string
  title?: string
  focus?: boolean
  activate?: boolean
  presentation?: RuntimeTerminalPresentation
  surfaceOwner?: false
  /** Main-internal: recheck early publication when the host is ready to reveal its pane. */
  agentLaunchViewer?: () => AgentLaunchTabViewerRule
  tabId?: string
  leafId?: string
  /** Layout-owner build: a pane this create writes stays when its start fails, showing why. */
  keepPaneOnStartFailure?: true
  /** With `keepPaneOnStartFailure`: a start already known to fail; only its pane is written. */
  startFailure?: Error
  /** Main-owned sleep wake publishes resume outcomes instead of relying on window restore. */
  resumesSleepingRecord?: true
  /** Refuse, rather than attach, when `tabId`/`leafId` name a pane whose PTY is already live. */
  requireFreshPane?: boolean
  sessionId?: string
  isNewSession?: boolean
  preAllocatedHandle?: string
  persistHostSessionBinding?: boolean
  agentSessionClaim?: AgentSessionExecutionClaim
  agentSessionCreateOperationId?: string
  /** The paired client's declared intent; the host's fork gate validates and may defer it. */
  spawnIntent?: SpawnIntent
  signal?: AbortSignal
  /** Refuse (`worktree_terminals_sleeping`) instead of waking a worktree the host has put to sleep. */
  refuseSleptWorktree?: boolean
  onPtySpawnCommitted?: () => void
  /** Called before the spawn request leaves this process; a throw before it proves nothing spawned. */
  onPtySpawnDispatched?: (launch?: {
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
  }) => void
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
  // Lost spawn replies can leave unnamed live PTYs; replay adopts by this original launch identity.
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
  /** Persist live terminal handle so readers can rejoin after pane-key movement. */
  terminalHandle?: string
  payload: ParsedAgentStatusPayload
  /** Set by the process-lifetime producer; see AgentHookServer.ingestTerminalStatus. */
  origin?: 'process'
  yieldsToHookSince?: number
  /** Projected from OSC 7501; the store applies it only where hooks do not speak for the pane. */
  fromProgramStatus?: true
  /** The program left no records, so a row it owns is removed rather than written. */
  removesProgramStatusRow?: true
  /** A repeat of the program's live report that renews its row's freshness lease. */
  renewsProgramStatusLease?: true
}

/** A pane's OSC 7501 facet changed. `facet: null` means the program's root record is gone. */
export type RuntimeTerminalProgramStatusFacetEvent = {
  ptyId: string
  paneKey: string
  facet: ProgramStatusFacet | null
}

export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  | 'payload'
  | 'updatedAt'
  | 'evidenceObservedAt'
  | 'stateStartedAt'
  | 'turnEndedAt'
  | 'turnEndDisposition'
  | 'worktreeId'
  | 'programStatus'
>

export type TerminalHandleRecord = {
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
  /** Issue-time stamp of the pane main bound a terminal handle for; read only by recoverTerminalPane. */
  issuedForPaneKey?: string
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

/** COMPAT(legacy-relay-bridge): bridge verifies an unhosted relay-era terminal only for this CLI attachment lifetime. */
export type OrchestrationCompatibilitySshTerminal = Readonly<{
  handle: string
  paneKey: string
  processIncarnation?: string
}>

export type TerminalWaiter = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  resolve: (result: RuntimeTerminalWait) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout | null
  /** Retires this waiter from the shared idle-poll sweep; null when not polling. */
  cancelIdlePoll: (() => void) | null
  abortCleanup: (() => void) | null
  /** Main-only launch-readiness wait: name-only titles require quiet output (TuiIdleEvaluationInput.launchReadiness). */
  launchReadiness?: boolean
}

/** How a provider-held screen should be fetched when runtime bytes are absent. */
export type RuntimeProviderSnapshotReadOptions = {
  timeoutMs?: number
  retireOnTimeout?: boolean
  visibleScreenOnly?: boolean
}

/** Agent-prompt writes add the correlation inputs a queued-acceptance receipt needs. */
export type RuntimeAgentPromptWriteOptions = Omit<RuntimeTerminalWriteOptions, 'inputKind'> & {
  /** `launch` for the prompt an agent starts with; `driving` for any prompt sent to a running one. */
  inputKind: Exclude<TerminalInputKind, 'query-reply'>
  /** Raw prompt text for submit scheduling; not written, only used for line-aware delays. */
  promptForSchedule?: string
  /** Caller observed composer input acceptance; schedule Enter using desktop draft-paste timing instead of render settlement. */
  composerReady?: boolean
  /** See buildAgentPromptPasteBytes. */
  leadLine?: string
  /** Return an accepted receipt as soon as input lands, instead of waiting for the turn. */
  acceptQueued?: boolean
  observationTimeoutMs?: number
  requestId?: string
  onInputAccepted?: (send: RuntimeTerminalSend) => void
  /** Wait through agent_prompt_blocked permissions until answer, exit, binding change or abort. */
  onPermission?: 'refuse' | 'wait'
  /** Refuse binding changes with terminal_handle_stale; never send admitted prompt text to a replacement process. */
  expectedBinding?: AgentPromptExpectedBinding
  /** Run on accepted Enter write, including OMP paste framing; later abort cannot undo submitted text. */
  onSubmitWritten?: () => void
}

export type AgentPromptExpectedBinding = { ptyId: string; processIncarnation: string }
