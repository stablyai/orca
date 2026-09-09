import type { AgentStatus } from '../../shared/agent-detection'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { RuntimeSyncedLeaf } from '../../shared/runtime-types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import type { TerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type { TuiAgent } from '../../shared/tui-agent'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'
import type { TerminalTailWaitState } from './terminal-wait-tail-state'
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
  tabId: string | null
  paneKey: string | null
  launchConfig: SleepingAgentLaunchConfig | null
  launchToken: string | null
  launchIncarnationId: PtyIncarnationId | null
  launchAgent: TuiAgent | null
  agentSessionOwners: AgentSessionOwnerBinding[]
  foregroundAgent: TuiAgent | null
  connected: boolean
  disconnectedAt: number | null
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  lastAgentStatus: AgentStatus | null
  lastAgentStatusObservedLive: boolean
  lastAgentStatusStartedAtEpochMs: number | null
  lastAgentStatusRichInvalidatedAtEpochMs: number | null
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  lastOscTitleEpochMs: number | null
  managementTitle: string | null
  managementTitleAt: number | null
  controllerTitle: string | null
  title: string | null
  titleUpdatedAt: number | null
  lastOutputAt: number | null
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
  commandCodeDetector: { observe: (data: string) => boolean } | null
}

export type RuntimeHeadlessTerminal = {
  emulator: HeadlessEmulator
  outputSequence: number
  writeChain: Promise<void>
  ownership: PtyShellOwnershipMirror
}

export type RuntimeVisibleTerminalState = {
  lines: string[]
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
