import type {
  AgentStatusCacheIdentity,
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
  /** Read after hydration so startup hook replays can attach to restored tabs. */
  getSnapshot: () => Promise<AgentStatusIpcPayload[]>
  inferInterrupt: (request: AgentInterruptInferenceRequest) => Promise<boolean>
  /** The CLI emits no answer hook, so the renderer reports the submit keystroke. */
  inferQuestionAnswered: (request: AgentQuestionAnsweredInferenceRequest) => Promise<boolean>
  /** Without host process verification, retain the existing silence-based cleanup. */
  hasVerifiableAgentProcess?: (paneKey: string) => Promise<boolean>
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
  /** Evict a previously-cleared status only when its identity still matches the main-process cache. */
  dropPersisted: (identity: AgentStatusCacheIdentity) => void
  dropPersistedBatch?: (identities: readonly AgentStatusCacheIdentity[]) => void
  /** Proven process exit also clears per-pane caches that a user dismissal retains. */
  reconcileEndedProcess: (paneKey: string) => void
  /** Drop every cached hook status under one terminal tab prefix. Fire-and-forget. */
  dropByTabPrefix: (tabId: string) => void
  /** Permanently retire one pane's hook authority while siblings stay live. */
  retirePaneAuthority: (paneKey: string, retirementId?: string) => void
  /** Lift one pane's retirement fence when a live PTY re-attaches to it. Closed tabs stay retired. */
  restorePaneAuthority: (paneKey: string) => void
  transferPaneAuthority: (args: { fromPaneKey: string; toPaneKey: string; ptyId?: string }) => void
}

export type AgentAwakeApi = {
  getStatus: () => Promise<ComputerAwakeStatus>
  onChanged: (callback: (status: ComputerAwakeStatus) => void) => () => void
}
