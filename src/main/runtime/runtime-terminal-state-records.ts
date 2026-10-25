import type { AgentStatus } from '../../shared/agent-detection'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { RuntimeSyncedLeaf } from '../../shared/runtime-types'
import type { RuntimeTerminalRowMetadata } from '../../shared/runtime-terminal-contracts'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import type { TerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalAgent } from '../../shared/terminal-agent'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'
import type { TerminalTailWaitState } from './terminal-wait-tail-state'
import type { TerminalCommandPaint } from './terminal-command-paint'
import type { CliWriterConversation } from './structured-agent-cli-writers'
import type { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'

type RuntimeTerminalTailState = {
  tailBuffer: string[]
  tailTranscriptBuffer: string[]
  tailTranscriptChars: number
  tailPartialLine: string
  tailPendingAnsi: string
  tailRedrawCursor: RetainedTailRedrawCursor | null
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
  waitBlockedAt: number | null
  tailWaitState?: TerminalTailWaitState
}

export type PtyRegistrationClaim = {
  incarnationId: PtyIncarnationId | null
  exitedIncarnations: Set<PtyIncarnationId | null>
}

export type RuntimeLeafRecord = RuntimeSyncedLeaf &
  RuntimeTerminalTailState & {
    ptyGeneration: number
    connected: boolean
    writable: boolean
    lastOutputAt: number | null
    lastExitCode: number | null
    lastExitCause: TerminalExitCause | null
    lastAgentStatus: AgentStatus | null
    lastAgentStatusObservedLive: boolean
    lastOscTitle: string | null
    lastOscTitleAt: number | null
    paneTitleUpdatedAt: number | null
  }

export type RuntimePtyWorktreeRecord = RuntimeTerminalTailState & {
  ptyId: string
  incarnationId: PtyIncarnationId | null
  worktreeId: string
  connectionId: string | null
  runtimeSessionOwned: boolean
  isWsl: boolean | null
  wslDistro: string | null
  /** Window-owned builds only (L80): read through paneOfPty; layout-owner records never carry it. */
  tabId?: string | null
  /** Window-owned builds only (L80): read through paneOfPty; layout-owner records never carry it. */
  paneKey?: string | null
  /**
   * Window-owned builds only (L80). `graphSequence` when `paneKey` was last written. A surface
   * recorded since the last graph statement has not yet been offered one that could contradict
   * it — see pty-recorded-surface-topology.ts.
   */
  surfaceRecordedAtGraphSequence?: number
  launchConfig: SleepingAgentLaunchConfig | null
  launchToken: string | null
  launchIncarnationId: PtyIncarnationId | null
  launchAgent: TuiAgent | null
  /** The agent a runtime-spawned `--command` names even when flags keep it unmanaged; names the
   *  pane before any foreground-process read lands. Null for adopted or restored panes. */
  launchCommandAgent: TuiAgent | null
  agentSessionOwners: AgentSessionOwnerBinding[]
  /** Conversations the `incarnationId` execution reported; a later row can't hide them. In memory only. */
  cliConversations?: {
    incarnationId: PtyIncarnationId | null
    byKey: Map<string, CliWriterConversation>
  }
  foregroundAgent: TerminalAgent | null
  connected: boolean
  disconnectedAt: number | null
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  lastAgentStatus: AgentStatus | null
  lastAgentStatusObservedLive: boolean
  /** Latest first-party state from the agent's own OSC 9999 status stream — what the
   *  agent SAYS it is doing, as opposed to `lastAgentStatus`, which is inferred from its
   *  OSC title. Optional: absent until a payload lands. */
  lastExplicitAgentStatus?: {
    state: AgentStatusState
    updatedAt: number
    /** A `done` row that marks a new session owning the pane, not the end of a turn. */
    sessionBoundary?: boolean
    /** OSC 7501 `done`: the program itself says it is at rest awaiting input, which a hook
     *  `done` (possibly mid-turn) cannot claim. */
    programAtRest?: boolean
  } | null
  lastAgentStatusStartedAtEpochMs: number | null
  lastAgentStatusRichInvalidatedAtEpochMs: number | null
  /** When a replacement process took over this PTY id; earlier hooks describe its predecessor. */
  providerGenerationResetAtEpochMs?: number
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  lastOscTitleEpochMs: number | null
  /** The stale-working timer's cleared title, dated as a genuine title would be, while it stands
   *  over `lastOscTitle`. Display readers project through it (getPtyDisplayRecord); evidence never
   *  reads it. On the record so it lives as long as the native title it retires. In memory only. */
  titleDisplayClear?: { title: string; observedAt: number; observedAtEpochMs: number } | null
  managementTitle: string | null
  managementTitleAt: number | null
  controllerTitle: string | null
  title: string | null
  titleUpdatedAt: number | null
  /** Wall clock for the recorded title; absent on older or unobserved records. */
  titleObservedAtEpochMs?: number | null
  /** The name a rename gave this terminal: display only, never title evidence (#20626). */
  manualTitle?: string | null
  lastOutputAt: number | null
  /** See terminal-command-paint.ts; absent until the pane's first output, and again after a gap or a new process. */
  commandPaint?: TerminalCommandPaint
}

export type RuntimePtyTabCloseAuthority = {
  handle: string
  ptyId: string
  incarnationId: PtyIncarnationId | null
  worktreeId: string
}

export type RuntimePtyTitleTrackerEntry = {
  tracker: TerminalTitleTracker
  applyingChunk: boolean
  lastMobileTitleGateKey: string | null
  /** When the last title fact was emitted — throttles decorative-only repeats. */
  lastTitleFactAtMs: number | null
  chunkTouchedSessionTabs: boolean
  pendingFacts: TerminalSideEffectFact[]
  /** Run once this chunk's facts are emitted: status that readers must see after them. */
  afterFacts: (() => void)[]
  commandCodeDetector: { observe: (data: string) => boolean } | null
  /** The program's OSC 7501 activity; while set it, not the title glyph, is the PTY's status. */
  programActivity: AgentStatus | null
  /** The last observed title, so a program's activity change can re-classify it. */
  lastTitle: { raw: string; normalized: string } | null
}

export type RuntimeHeadlessTerminal = {
  emulator: HeadlessEmulator
  outputSequence: number
  writeChain: Promise<void>
  ownership: PtyShellOwnershipMirror
  /** The grid a reattach reflowed the model onto, until a PTY resize off it repaints the TUI. */
  unrepaintedReflowGrid?: { cols: number; rows: number }
}

export type RuntimeVisibleTerminalState = {
  lines: string[]
  tailRows?: RuntimeTerminalRowMetadata[]
  draft?: string
  isAlternateScreen: boolean
  sequence: number
  generation: number
}

export type ProviderBufferAcquisition = {
  generation: number
  scrollbackRows: number
  promise: Promise<PtyProviderBufferSnapshot | null>
  timedOut: boolean
}

export type RuntimeTerminalBufferSnapshot = {
  data: string
  frameRestoreAnsi?: string
  cols: number
  rows: number
  seq?: number
  cwd?: string | null
  lastTitle?: string
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
  kittyKeyboardFlags?: number
}

export type HeadlessSeedMetadata = {
  cwd?: string | null
  oscLinks?: TerminalOscLinkRange[]
  preferProviderIfExisting?: boolean
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
}
