import type { AgentStatus } from '../../shared/agent-detection'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  RetainedTailRedrawCursor,
  RuntimePtyController,
  TerminalTailWaitState
} from './orca-runtime'

// Owner of the PTY hub state OrcaRuntimeService used to hold as three bare
// fields. Step one of extracting the terminal-transport state owner: the state
// moves here, the behavior does not. OrcaRuntimeService keeps delegating
// getters, so its ~234 internal references and the `runtime as unknown as {…}`
// casts in the test suite all still resolve to these exact objects.
//
// Why accessors beside the raw maps: the 47 runtime methods that touch PTY
// state only incidentally ask questions ("is this pty live?") rather than
// mutate. Giving them a named accessor is what lets the maps eventually stop
// being reachable from the rest of the class.
//
// The two map value types live here because the registry owns their maps.
// RuntimePtyController and the tail-state types still sit in orca-runtime.ts
// and are imported type-only, so nothing is emitted and the runtime import
// graph stays one-directional; they follow when their methods do.

export type RuntimePtyWorktreeRecord = {
  ptyId: string
  incarnationId: PtyIncarnationId | null
  worktreeId: string
  connectionId: string | null
  runtimeSessionOwned: boolean
  // Why: a Windows host can own both native and WSL panes; preamble command
  // selection must follow the pane that executes it, not process.platform.
  isWsl: boolean | null
  wslDistro: string | null
  // Why: background CLI PTYs can outlive a failed renderer reveal. Preserve the
  // spawn-time tab/pane identity so later reveals can adopt under the env key.
  tabId: string | null
  paneKey: string | null
  launchConfig: SleepingAgentLaunchConfig | null
  launchToken: string | null
  // Why: provider PTY IDs can be reused; launch identity belongs only to the process that received the token.
  launchIncarnationId: PtyIncarnationId | null
  launchAgent: TuiAgent | null
  foregroundAgent: TuiAgent | null
  connected: boolean
  disconnectedAt: number | null
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  lastAgentStatus: AgentStatus | null
  /** False until a live OSC frame sets the status; restore seeds never set it. */
  lastAgentStatusObservedLive: boolean
  lastAgentStatusStartedAtEpochMs: number | null
  // A later semantic title interval cannot inherit rich fields from an earlier task.
  lastAgentStatusRichInvalidatedAtEpochMs: number | null
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  // Why a second stamp: `lastOscTitleAt` is a title-observation sequence number,
  // comparable only to other title stamps. Anything that must date a live title
  // against an off-pane clock (hook `receivedAt`) needs wall-clock ms.
  lastOscTitleEpochMs: number | null
  managementTitle: string | null
  managementTitleAt: number | null
  controllerTitle: string | null
  title: string | null
  titleUpdatedAt: number | null
  lastOutputAt: number | null
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
  // Why: memoized wait scan of the current retained tail (see RuntimeLeafRecord).
  tailWaitState?: TerminalTailWaitState
}

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

export class RuntimePtyRegistry {
  /** ptyId -> the worktree record tracking that live process. */
  readonly ptysById = new Map<string, RuntimePtyWorktreeRecord>()

  /** handle id -> the terminal binding that currently owns it. */
  readonly handles = new Map<string, TerminalHandleRecord>()

  private controller: RuntimePtyController | null = null

  getController(): RuntimePtyController | null {
    return this.controller
  }

  setController(controller: RuntimePtyController | null): void {
    this.controller = controller
  }

  getPty(ptyId: string): RuntimePtyWorktreeRecord | undefined {
    return this.ptysById.get(ptyId)
  }

  hasPty(ptyId: string): boolean {
    return this.ptysById.has(ptyId)
  }

  get ptyCount(): number {
    return this.ptysById.size
  }

  ptyIds(): IterableIterator<string> {
    return this.ptysById.keys()
  }

  ptyRecords(): IterableIterator<RuntimePtyWorktreeRecord> {
    return this.ptysById.values()
  }

  getHandle(handle: string): TerminalHandleRecord | undefined {
    return this.handles.get(handle)
  }

  hasHandle(handle: string): boolean {
    return this.handles.has(handle)
  }

  handleRecords(): IterableIterator<TerminalHandleRecord> {
    return this.handles.values()
  }
}
