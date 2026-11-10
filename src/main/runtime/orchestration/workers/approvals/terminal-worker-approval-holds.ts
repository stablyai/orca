/** Claude terminal workers' permission prompts, one record per waiting PermissionRequest hook. The
 *  record is answerable only while its hook waits and Claude's dialog is on the worker's screen. */
import { createHash } from 'node:crypto'
import type {
  ClaudePermissionHold,
  ClaudePermissionHoldEnd,
  ClaudePermissionHookChannel,
  ClaudePermissionHolds
} from '../../../../agent-hooks/server/claude-permission-hook-hold'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import {
  reportWorkerApprovalClosed,
  type WorkerTurnStopReportDeps
} from '../turn-stops/worker-turn-stop-report'
import type {
  WorkerApprovalDecision,
  WorkerApprovalOutcome,
  WorkerApprovalPayload
} from './worker-approval'

// Why 500 ms: Esc posts no hook, so only the screen says the dialog left; a click is refused within it.
const DIALOG_POLL_MS = 500
// Why 3 s: Claude closes its dialog at once on a hook's answer (probe F2); longer means it was not taken.
const ANSWER_TAKEN_WAIT_MS = 3_000
// A closed prompt waits this long for its tool's result before its closing line says no more than "closed".
const CLOSE_EVIDENCE_MS = 10 * 60_000

export type TerminalWorkerApprovalHoldsDeps = Pick<WorkerTurnStopReportDeps, 'notify'> & {
  /** This pane's worker and its active local Dispatch, as the turn-stop report resolves it. */
  resolveWorker: (
    paneKey: string
  ) => { db: OrchestrationDb; handle: string; dispatch: DispatchContextRow } | null
  /** False where a hook's answer cannot reach Claude: Windows, WSL and SSH panes. */
  canAnswerPane: (paneKey: string) => boolean
  /** Whether Claude's permission dialog is on the pane's screen now; null when unreadable. */
  showsDialog: (paneKey: string) => boolean | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
}

type Hold = {
  approvalId: string
  key: string
  paneKey: string
  toolUseId: string
  handle: string
  db: OrchestrationDb
  dispatch: DispatchContextRow
  summary: WorkerApprovalPayload['summary']
  channel: ClaudePermissionHookChannel
  /** Compare-and-set: only the step out of `open` may write a decision to the hook. */
  state: 'open' | 'answered' | 'closed'
  dialogSeen: boolean
  /** The coordinator was told about it, so it is owed one closing line. */
  reported: boolean
  timer: { cancel: () => void } | null
}

export type TerminalWorkerApprovalAnswer =
  | { ok: true; approval: WorkerApprovalPayload }
  | {
      ok: false
      code: 'approval_not_open' | 'approval_refused'
      message: string
    }

export class TerminalWorkerApprovalHolds implements ClaudePermissionHolds {
  private readonly byApprovalId = new Map<string, Hold>()
  private readonly openByPane = new Map<string, Hold>()
  /** Closed by the dialog, awaiting the tool's result to say how. */
  private readonly closingByToolUseId = new Map<string, Hold>()

  constructor(private readonly deps: TerminalWorkerApprovalHoldsDeps) {}

  admit(request: ClaudePermissionHold): boolean {
    const { event, promptId } = request
    const { paneKey, toolUseId } = event
    // No single open call matches it (or none was seen): the screen alone cannot say which it is.
    if (!toolUseId || !promptId || event.toolAgentId !== undefined) {
      return false
    }
    const worker = this.deps.canAnswerPane(paneKey) ? this.deps.resolveWorker(paneKey) : null
    if (!worker) {
      return false
    }
    const other = this.openByPane.get(paneKey)
    if (other) {
      // Two prompts in one pane: the screen cannot say which one it shows, so neither is answerable.
      this.close(other, null)
      return false
    }
    const key = JSON.stringify([promptId, toolUseId])
    const hold: Hold = {
      approvalId: `apr_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      key,
      paneKey,
      toolUseId,
      handle: worker.handle,
      db: worker.db,
      dispatch: worker.dispatch,
      summary: {
        title: event.payload.toolName ?? 'Tool call',
        detail: event.payload.toolInput ?? null,
        reason: null
      },
      channel: request.openChannel(),
      state: 'open',
      dialogSeen: false,
      reported: false,
      timer: null
    }
    this.byApprovalId.set(hold.approvalId, hold)
    this.openByPane.set(paneKey, hold)
    hold.channel.onEnd((why) => this.ended(hold, why))
    this.watchDialog(hold)
    return true
  }

  /** Every accepted Claude event: a tool's result says how a dialog closed. */
  observe(event: AgentHookEventPayload): void {
    if (event.hookEventName === 'PostToolUse' && event.toolUseId) {
      const open = this.openByPane.get(event.paneKey)
      const hold =
        open?.toolUseId === event.toolUseId ? open : this.closingByToolUseId.get(event.toolUseId)
      if (hold?.paneKey === event.paneKey) {
        this.close(hold, { by: 'worker-terminal', decision: 'allow' })
      }
      return
    }
    // A lead's turn ended: whatever closed its dialog left no result to name.
    if (
      event.toolAgentId === undefined &&
      (event.hookEventName === 'Stop' || event.hookEventName === 'StopFailure')
    ) {
      for (const hold of this.closingByToolUseId.values()) {
        if (hold.paneKey === event.paneKey) {
          this.close(hold, null)
        }
      }
    }
  }

  /** The open approval this pane's worker waits on, for its one escalation. */
  takeOpenApproval(paneKey: string, dispatchId: string): WorkerApprovalPayload | null {
    const hold = this.openByPane.get(paneKey)
    if (!hold || hold.state !== 'open' || hold.dispatch.id !== dispatchId) {
      return null
    }
    hold.reported = true
    return this.payload(hold)
  }

  async answer(input: {
    dispatchId: string
    approvalId: string
    decision: WorkerApprovalDecision
    message: string
  }): Promise<TerminalWorkerApprovalAnswer> {
    const hold = this.byApprovalId.get(input.approvalId)
    const worker = hold ? this.deps.resolveWorker(hold.paneKey) : null
    if (
      !hold ||
      hold.dispatch.id !== input.dispatchId ||
      hold.state !== 'open' ||
      worker?.dispatch.id !== hold.dispatch.id ||
      worker.handle !== hold.handle ||
      this.deps.showsDialog(hold.paneKey) === false
    ) {
      return {
        ok: false,
        code: 'approval_not_open',
        message: `This prompt is no longer open: ${input.approvalId} was answered, or left the worker's screen.`
      }
    }
    hold.state = 'answered'
    this.release(hold)
    const written = await hold.channel.answer(
      input.decision === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: input.message }
    )
    if (!written || !(await this.dialogLeaves(hold.paneKey))) {
      return {
        ok: false,
        code: 'approval_refused',
        message: `The worker did not take the answer to ${input.approvalId}; a person must answer it in the worker's terminal.`
      }
    }
    return { ok: true, approval: this.payload(hold) }
  }

  private watchDialog(hold: Hold): void {
    hold.timer = this.deps.setTimer(() => {
      if (hold.state !== 'open') {
        return
      }
      const shown = this.deps.showsDialog(hold.paneKey)
      if (shown === false && hold.dialogSeen) {
        // The person answered, Esc dismissed it, or Claude's 2:00 auto-block fired; the result says which.
        this.closeAwaitingEvidence(hold)
        return
      }
      hold.dialogSeen ||= shown === true
      this.watchDialog(hold)
    }, DIALOG_POLL_MS)
  }

  private ended(hold: Hold, why: ClaudePermissionHoldEnd): void {
    // Claude ends a waiting hook only when the person presses No (probe F3).
    this.close(hold, why === 'hook-gone' ? { by: 'worker-terminal', decision: 'deny' } : null)
  }

  private closeAwaitingEvidence(hold: Hold): void {
    hold.state = 'closed'
    this.release(hold)
    void hold.channel.answer(null)
    if (!hold.reported) {
      return
    }
    this.closingByToolUseId.set(hold.toolUseId, hold)
    hold.timer = this.deps.setTimer(() => this.close(hold, null), CLOSE_EVIDENCE_MS)
  }

  /** Ends a record not answered through Orca; a reported one gets its one closing line. */
  private close(hold: Hold, how: Pick<WorkerApprovalOutcome, 'by' | 'decision'> | null): void {
    if (hold.state === 'answered') {
      return
    }
    hold.state = 'closed'
    this.release(hold)
    this.closingByToolUseId.delete(hold.toolUseId)
    void hold.channel.answer(null)
    if (!hold.reported) {
      return
    }
    hold.reported = false
    reportWorkerApprovalClosed(
      hold.db,
      hold.dispatch,
      {
        from: hold.handle,
        approval: this.payload(hold, {
          by: how?.by ?? 'unknown',
          decision: how?.decision ?? null,
          reason: null,
          reasonDelivered: true
        })
      },
      this.deps
    )
  }

  private release(hold: Hold): void {
    hold.timer?.cancel()
    hold.timer = null
    if (this.openByPane.get(hold.paneKey) === hold) {
      this.openByPane.delete(hold.paneKey)
    }
    this.byApprovalId.delete(hold.approvalId)
  }

  private dialogLeaves(paneKey: string): Promise<boolean> {
    return new Promise((resolve) => {
      let waited = 0
      const check = (): void => {
        if (this.deps.showsDialog(paneKey) === false) {
          resolve(true)
          return
        }
        waited += DIALOG_POLL_MS / 2
        if (waited > ANSWER_TAKEN_WAIT_MS) {
          resolve(false)
          return
        }
        this.deps.setTimer(check, DIALOG_POLL_MS / 2)
      }
      this.deps.setTimer(check, DIALOG_POLL_MS / 2)
    })
  }

  private payload(hold: Hold, outcome?: WorkerApprovalOutcome): WorkerApprovalPayload {
    return {
      v: 1,
      approvalId: hold.approvalId,
      state: outcome ? (outcome.decision === null ? 'expired' : 'answered') : 'open',
      worker: { handle: hold.handle, dispatchId: hold.dispatch.id, taskId: hold.dispatch.task_id },
      summary: hold.summary,
      allowedActions: outcome ? [] : ['allow', 'deny'],
      ...(outcome ? { outcome } : {})
    }
  }
}
