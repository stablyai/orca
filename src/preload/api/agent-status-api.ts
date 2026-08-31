import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../shared/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../../shared/agent-question-answered-intent'
import type { ComputerAwakeStatus } from '../../shared/computer-awake-mode'

export type AgentStatusApi = {
  /** Listen for agent status updates forwarded from native hook receivers. */
  onSet: (callback: (data: AgentStatusIpcPayload) => void) => () => void
  /** Listen for main-process cleanup that evicted cached hook status. */
  onClear: (callback: (data: AgentStatusClearIpcPayload) => void) => () => void
  /** Return the current main-process hook cache after renderer hydration. */
  getSnapshot: () => Promise<AgentStatusIpcPayload[]>
  inferInterrupt: (request: AgentInterruptInferenceRequest) => Promise<boolean>
  /** Guarded clear for an answered AskUserQuestion wait — the CLI emits no hook at answer time, so the renderer reports the submit keystroke. */
  inferQuestionAnswered: (request: AgentQuestionAnsweredInferenceRequest) => Promise<boolean>
  /** Listen for PTYs on a legacy numeric pane key that have registry-backed UUID pane proof. */
  onMigrationUnsupported: (callback: (entry: MigrationUnsupportedPtyEntry) => void) => () => void
  onMigrationUnsupportedClear: (callback: (data: { ptyId: string }) => void) => () => void
  onLegacyWorkerTerminalRecovery: (
    callback: (data: {
      paneKey: string
      resolution: 'adopted' | 'exited' | 'rolled_back'
      ptyId?: string
    }) => void
  ) => () => void
  getMigrationUnsupportedSnapshot: () => Promise<MigrationUnsupportedPtyEntry[]>
  /** Drop a paneKey from the main-process hook cache and on-disk last-status file. Fire-and-forget. */
  drop: (paneKey: string) => void
  /** Retire a pane whose agent process is proven gone — clears the row AND the per-pane caches a
   *  dismissal deliberately keeps. Not `drop`: that one is a user dismissal of a live pane's row. */
  reconcileEndedProcess: (paneKey: string) => void
  /** Drop every cached hook status under one terminal tab prefix. Fire-and-forget. */
  dropByTabPrefix: (tabId: string) => void
  /** Permanently retire one pane's hook authority while siblings stay live. */
  retirePaneAuthority: (paneKey: string) => void
  /** Lift one pane's retirement fence when a live PTY re-attaches to it. Closed tabs stay retired. */
  restorePaneAuthority: (paneKey: string) => void
  /** Move hook authority when a live pane is detached into another tab. */
  transferPaneAuthority: (args: { fromPaneKey: string; toPaneKey: string; ptyId?: string }) => void
}

export type AgentTrustApi = {
  markTrusted: (args: {
    preset: 'cursor' | 'copilot' | 'codex'
    workspacePath: string
    connectionId?: string
  }) => Promise<void>
}

export type AgentAwakeApi = {
  getStatus: () => Promise<ComputerAwakeStatus>
  onChanged: (callback: (status: ComputerAwakeStatus) => void) => () => void
}
