/** The state of one Claude terminal worker's waiting permission prompt, and what the holds need. */
import type { ClaudePermissionHookChannel } from '../../../../agent-hooks/server/claude-permission-hook-hold'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { claudeTookHookAnswer, type ClaudeToolRecord } from './claude-tool-result-close'
import { firstWithin } from './first-within'
import { showsClaudeDialog } from '../../../terminal/wait/claude-open-dialog-hold'
import {
  reportWorkerApprovalClosed,
  type WorkerTurnStopReportDeps
} from '../turn-stops/worker-turn-stop-report'
import {
  closedApproval,
  type WorkerApprovalOutcome,
  type WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

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
  /** The hook decision and tool_result Claude's transcript records for this tool call, once written. */
  readToolRecord: (call: {
    transcriptPath: string
    toolUseId: string
  }) => Promise<ClaudeToolRecord | null>
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
  /** Its PostToolUse or PostToolUseFailure arrived while an answer was in flight: the tool ran. */
  ranSeen: boolean
  /** The decision Orca wrote and Claude took; set once answered. */
  answeredWith?: 'allow' | 'deny'
  expiresAt?: string
  /** The coordinator was told about it, so it is owed one closing line. */
  reported: boolean
  /** How Orca closed it, once closed other than by its own answer. */
  closedAs?: TerminalWorkerApprovalCloseHow | null
  timer: { cancel: () => void } | null
}

export type TerminalWorkerApprovalCloseHow = Pick<WorkerApprovalOutcome, 'by' | 'decision'>

// Claude's words for a check no hook may approve (2.1.322 strings: "allow rules, hooks and plugins
// cannot approve it", "hooks cannot approve …"); its dialog shows them as the warning.
const HOOKS_CANNOT_APPROVE = /\bhooks\b[^.]*\bcannot (?:approve|grant)\b/i

/** Claude lets only a person at its terminal allow this prompt. */
export function holdIsPersonOnly(hold: Pick<TerminalWorkerApprovalHold, 'summary'>): boolean {
  return HOOKS_CANNOT_APPROVE.test(hold.summary.reason ?? '')
}

/** An allow Claude will not take: its check is one only a person at the terminal may approve, or it
 *  dropped Orca's allow and still asks. */
export function droppedAllowRefusal(
  hold: TerminalWorkerApprovalHold,
  input: { approvalId: string; decision: 'allow' | 'deny' }
): TerminalWorkerApprovalAnswer | null {
  if (
    input.decision !== 'allow' ||
    (hold.closedAs?.by !== 'terminal-only' && !holdIsPersonOnly(hold))
  ) {
    return null
  }
  return {
    ok: false,
    code: 'approval_requires_person',
    message: `Claude lets only a person approve ${input.approvalId}, in the worker's terminal, so it stays with the user.`
  }
}

export type TerminalWorkerApprovalAnswer =
  | { ok: true; approval: WorkerApprovalPayload }
  | { ok: false; code: 'approval_not_open' | 'approval_requires_person'; message: string }

/** The approval as its escalation and closing message carry it. */
export function holdPayload(
  hold: TerminalWorkerApprovalHold,
  outcome?: WorkerApprovalOutcome
): WorkerApprovalPayload {
  const open: WorkerApprovalPayload = {
    v: 1,
    approvalId: hold.approvalId,
    state: 'open',
    worker: { handle: hold.handle, dispatchId: hold.dispatch.id, taskId: hold.dispatch.task_id },
    summary: hold.summary,
    allowedActions: ['allow', 'deny'],
    ...(holdIsPersonOnly(hold) ? { personOnly: true } : {}),
    ...(hold.expiresAt ? { expiresAt: hold.expiresAt } : {})
  }
  return outcome ? closedApproval(open, outcome) : open
}

/** Whether Claude took the answer Orca just wrote to this hook. Claude takes a hook's answer at once,
 *  so its dialog leaves or its tool runs; it records an allow only with the tool's result, which a
 *  long command delays, so only a record already there can name a person or the auto-block. */
export async function claudeTookAnswer(
  hold: TerminalWorkerApprovalHold,
  deps: Pick<TerminalWorkerApprovalHoldsDeps, 'readScreen' | 'readToolRecord' | 'setTimer'>,
  answer: { decision: 'allow' | 'deny'; message: string }
): Promise<{ taken: boolean; record: ClaudeToolRecord | null }> {
  const left = await firstWithin(deps.setTimer, () => {
    const lines = deps.readScreen(hold.paneKey)
    return hold.ranSeen || (lines && !showsClaudeDialog(lines)) ? true : null
  })
  if (!left) {
    return { taken: false, record: null }
  }
  // A deny is recorded at once, so only its record proves it; an allow's waits on its tool.
  const record =
    answer.decision === 'deny'
      ? await firstWithin(deps.setTimer, () => deps.readToolRecord(hold))
      : await deps.readToolRecord(hold).catch(() => null)
  const taken = record
    ? claudeTookHookAnswer(record, answer.decision, answer.message)
    : answer.decision === 'allow'
  return { taken, record }
}

/** The prompt's one closing line, or with `refines` its correction. */
export function reportHoldClosed(
  hold: TerminalWorkerApprovalHold,
  how: TerminalWorkerApprovalCloseHow | null,
  deps: Pick<TerminalWorkerApprovalHoldsDeps, 'notify'>,
  refines: boolean
): void {
  reportWorkerApprovalClosed(
    hold.db,
    hold.dispatch,
    {
      from: hold.handle,
      approval: holdPayload(hold, {
        by: how?.by ?? 'unknown',
        decision: how?.decision ?? null,
        reason: null,
        reasonDelivered: false
      })
    },
    deps,
    refines
  )
}
