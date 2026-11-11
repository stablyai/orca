/** The state of one Claude terminal worker's waiting permission prompt, and what the holds need. */
import type { ClaudePermissionHookChannel } from '../../../../agent-hooks/server/claude-permission-hook-hold'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import type { WorkerTurnStopReportDeps } from '../turn-stops/worker-turn-stop-report'
import type { ClaudeToolResult } from './claude-tool-result-close'
import type { WorkerApprovalOutcome, WorkerApprovalPayload } from './worker-approval'

export type TerminalWorkerApprovalHoldsDeps = Pick<WorkerTurnStopReportDeps, 'notify'> & {
  /** This pane's worker and its active local Dispatch, as the turn-stop report resolves it. */
  resolveWorker: (
    paneKey: string
  ) => { db: OrchestrationDb; handle: string; dispatch: DispatchContextRow } | null
  /** False where a hook's answer cannot reach Claude: Windows, WSL and SSH panes. */
  canAnswerPane: (paneKey: string) => boolean
  /** The pane's process run; a restarted agent is a different prompt. */
  processIncarnation: (handle: string) => string | null
  /** The pane's screen once it has applied every PTY chunk; null while it lags or is unreadable. */
  readScreen: (paneKey: string) => readonly string[] | null
  /** The tool_result Claude's transcript records for this tool call, once written. */
  readToolResult: (call: {
    transcriptPath: string
    toolUseId: string
  }) => Promise<ClaudeToolResult | null>
  now: () => number
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
}

export type TerminalWorkerApprovalHold = {
  approvalId: string
  paneKey: string
  toolUseId: string
  transcriptPath: string
  handle: string
  incarnation: string | null
  db: OrchestrationDb
  dispatch: DispatchContextRow
  summary: WorkerApprovalPayload['summary']
  channel: ClaudePermissionHookChannel
  /** Compare-and-set: only the step out of `open` may write a decision to the hook. */
  state: 'open' | 'answering' | 'answered' | 'closed'
  dialogSeen: boolean
  /** Its card already closed; the tool's result may still name how, without waking anyone. */
  refinable: boolean
  /** Its PostToolUse arrived while an answer was in flight: the tool ran. */
  ranSeen: boolean
  expiresAt?: string
  /** The coordinator was told about it, so it is owed one closing line. */
  reported: boolean
  timer: { cancel: () => void } | null
}

export type TerminalWorkerApprovalCloseHow = Pick<WorkerApprovalOutcome, 'by' | 'decision'>

export type TerminalWorkerApprovalAnswer =
  | { ok: true; approval: WorkerApprovalPayload }
  | { ok: false; code: 'approval_not_open'; message: string }
