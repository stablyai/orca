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
  /** The caller's own measured pane size; wins over the group's measured size and the 120x40 fallback. */
  initialSize?: { cols: number; rows: number }
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  startupAgent?: TuiAgent
  /**
   * Initial text offered to `startupAgent`'s launch command, for an agent whose CLI takes a prompt
   * argument. Not a general prompt channel: an agent that takes its text only after start has no
   * launch command to carry it, and a caller that sets this for one is refused rather than having
   * the prompt silently dropped. The text rides only when the typed line can carry it
   * (`startup-line-prompt-carry`); otherwise the agent starts clean, `onStartupPromptCarry` says so,
   * and post-start delivery belongs to whoever owns the live PTY.
   */
  startupPrompt?: string
  /**
   * `draft` puts `startupPrompt` in the agent's composer unsent, through its draft flag or env.
   * TEMPORARY (createAgentSession parity, removed by the PR that gives prompts and drafts one
   * delivery policy): a draft skips the typed-line carry rule, as it did before this planner.
   */
  startupPromptDelivery?: 'auto-submit' | 'draft'
  /**
   * TEMPORARY (createAgentSession parity, removed by the PR that delivers uncarried prompts after
   * start): `startupPrompt` rides the typed line at any size, and an agent that reads it only after
   * start launches clean instead of being refused, as createAgentSession did before this planner.
   */
  startupPromptCarry?: 'force-line'
  /** Main-internal: whether `startupPrompt` rode the launch command. Called once the plan is built. */
  onStartupPromptCarry?: (carried: boolean) => void
  /**
   * Replaces the Settings launch arguments for this `startupAgent` only; `null` means none at all.
   *
   * Not part of `callerSuppliedLaunch`: that guard refuses a caller that brought its own *command*,
   * which would contradict the agent the runtime is resolving. Arguments are an input to the plan
   * the runtime still builds, so overriding them does not take the launch away from it.
   */
  agentArgs?: string | null
  /** Main-internal: the runtime fact this agent's command was quoted for; its spawn takes the PTY
   *  shell from it. Set by the host planner or a host caller that quoted with it, never a client. */
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
  /** The surface that asked for this `startupAgent` launch; the runtime attributes every one it
   *  builds, as `unknown` when this is absent or unrecognized. Ignored without `startupAgent`. */
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
  /** Layout-owner build: main's start wakes the pane's sleeping record in place of the window's
   *  own restore, so it publishes whether the agent came back. */
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

/** COMPAT(legacy-relay-bridge): a relay-era terminal this runtime no longer hosts, which the
 *  bridge verified for the one CLI call its attachment lives for. */
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
  /** Main-internal: waiting for a just-launched agent, so a name-only title must be held to a
   *  quiet stream (`TuiIdleEvaluationInput.launchReadiness`). */
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
  /** The caller just saw this agent's composer accept input, so Enter follows the paste on the
   *  desktop draft paste's timing instead of waiting for the render to settle. */
  composerReady?: boolean
  /** Active-agent notes can use the host's ingest and settle delay without a startup render marker. */
  waitForRender?: boolean
  /** See buildAgentPromptPasteBytes. */
  leadLine?: string
  /** Return an accepted receipt as soon as input lands, instead of waiting for the turn. */
  acceptQueued?: boolean
  observationTimeoutMs?: number
  requestId?: string
  onInputAccepted?: (send: RuntimeTerminalSend) => void
  /** `wait` holds the write while the agent asks for permission instead of refusing it with
   *  `agent_prompt_blocked`; an answer, a process exit or binding change, or `signal` ends the hold. */
  onPermission?: 'refuse' | 'wait'
  /** The binding the caller admitted (`getTerminalPromptRequestBinding`); a different process is
   *  refused with `terminal_handle_stale` instead of receiving the text. */
  expectedBinding?: AgentPromptExpectedBinding
  /** Runs as soon as the write carrying Enter is accepted (OMP's paste frame included), before any
   *  later abort check can throw: the text is submitted whatever the call then answers. */
  onSubmitWritten?: () => void
}

export type AgentPromptExpectedBinding = { ptyId: string; processIncarnation: string }
