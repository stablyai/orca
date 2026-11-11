/** Claude terminal workers' permission prompts, one record per waiting PermissionRequest hook. The
 *  record is answerable only while its hook waits and Claude's dialog is on the worker's screen, and
 *  how it closed is named only from what Claude leaves on that screen. */
import { createHash } from 'node:crypto'
import type {
  ClaudePermissionHold,
  ClaudePermissionHoldEnd,
  ClaudePermissionHolds
} from '../../../../agent-hooks/server/claude-permission-hook-hold'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import {
  claudeDialogExpiresAt,
  claudeDialogWarning,
  showsClaudeDialog
} from '../../../terminal/wait/claude-open-dialog-hold'
import { claudeToolClose } from './claude-tool-result-close'
import type { ClaudeToolClose, ClaudeToolResult } from './claude-tool-result-close'
import { firstWithin } from './first-within'
import type {
  TerminalWorkerApprovalAnswer,
  TerminalWorkerApprovalCloseHow,
  TerminalWorkerApprovalHold,
  TerminalWorkerApprovalHoldsDeps
} from './terminal-worker-approval-hold'
import { reportWorkerApprovalClosed } from '../turn-stops/worker-turn-stop-report'
import { closedApproval } from './worker-approval'
import type {
  WorkerApprovalDecision,
  WorkerApprovalOutcome,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import { TERMINAL_APPROVAL_ID_PREFIX } from './worker-approval-report'

// Why 500 ms: Esc posts no hook, so only the screen says the dialog left; a click is refused within it.
const DIALOG_POLL_MS = 500
// How each tool_result names a close Orca did not make; null says no more than "closed".
const CLOSE_OF: Record<ClaudeToolClose, CloseHow | null> = {
  ran: { by: 'worker-terminal', decision: 'allow' },
  'user-denied': { by: 'worker-terminal', decision: 'deny' },
  'auto-denied': { by: 'auto', decision: 'deny' },
  'hook-denied': null,
  other: null
}
// A closed prompt waits this long for its tool's result before its closing line says no more than "closed".
const CLOSE_EVIDENCE_MS = 10 * 60_000

type Hold = TerminalWorkerApprovalHold
type CloseHow = TerminalWorkerApprovalCloseHow

export class TerminalWorkerApprovalHolds implements ClaudePermissionHolds {
  private readonly byApprovalId = new Map<string, Hold>()
  private readonly openByPane = new Map<string, Hold>()
  /** Closed by the dialog, awaiting the tool's result to say how. */
  private readonly closingByToolUseId = new Map<string, Hold>()

  constructor(private readonly deps: TerminalWorkerApprovalHoldsDeps) {}

  admit(request: ClaudePermissionHold): boolean {
    const { event, promptId } = request
    const { paneKey, toolUseId } = event
    const transcriptPath = event.providerSession?.transcriptPath
    // No single open call matches it, or no transcript can say how it closed.
    if (!toolUseId || !promptId || !transcriptPath || event.toolAgentId !== undefined) {
      return false
    }
    const worker = this.deps.canAnswerPane(paneKey) ? this.deps.resolveWorker(paneKey) : null
    if (!worker) {
      return false
    }
    const other = this.openByPane.get(paneKey)
    if (other) {
      // Two prompts in one pane: the screen cannot say which one it shows, so neither is answerable.
      this.close(other, { by: 'terminal-only', decision: null })
      return false
    }
    const hold: Hold = {
      approvalId: `${TERMINAL_APPROVAL_ID_PREFIX}${createHash('sha256')
        .update(JSON.stringify([promptId, toolUseId]))
        .digest('hex')
        .slice(0, 16)}`,
      paneKey,
      toolUseId,
      transcriptPath,
      handle: worker.handle,
      incarnation: this.deps.processIncarnation(worker.handle),
      db: worker.db,
      dispatch: worker.dispatch,
      summary: {
        title: `Allow ${event.payload.toolName ?? 'this tool call'}?`,
        detail: event.payload.toolInput ?? null,
        reason: null
      },
      channel: request.openChannel(),
      state: 'open',
      dialogSeen: false,
      refinable: false,
      ranSeen: false,
      reported: false,
      timer: null
    }
    this.byApprovalId.set(hold.approvalId, hold)
    this.openByPane.set(paneKey, hold)
    hold.channel.onEnd((why) => void this.ended(hold, why))
    this.watchDialog(hold)
    return true
  }

  /** Every accepted Claude event: a tool's result says how a dialog closed. */
  observe(event: AgentHookEventPayload): void {
    if (event.hookEventName === 'PostToolUse' && event.toolUseId) {
      const open = this.openByPane.get(event.paneKey)
      const hold =
        open?.toolUseId === event.toolUseId ? open : this.closingByToolUseId.get(event.toolUseId)
      if (hold?.paneKey !== event.paneKey) {
        return
      }
      hold.ranSeen = true
      if (hold.state !== 'answering') {
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
          // One last read: a result written late still names the close.
          void this.deps
            .readToolResult(hold)
            .then((result) => this.close(hold, result && CLOSE_OF[claudeToolClose(result, null)]))
        }
      }
    }
  }

  /** The open approval this pane's worker waits on, for its one escalation. */
  /** Whether Orca still holds this prompt's hook, answering or not. */
  isHeld(approvalId: string): boolean {
    return this.byApprovalId.has(approvalId)
  }

  takeOpenApproval(paneKey: string, dispatchId: string): WorkerApprovalPayload | null {
    const hold = this.openByPane.get(paneKey)
    if (hold?.state !== 'open' || hold.dispatch.id !== dispatchId) {
      return null
    }
    hold.reported = true
    // The escalation usually goes out before the first poll, so read the dialog here too.
    this.readDialog(hold, this.deps.readScreen(paneKey))
    return this.payload(hold)
  }

  /** Writes a decision only to a dialog still on a caught-up screen, and claims it only once this
   *  call's tool_result shows Claude took it: a Yes, a No or the 2:00 auto-block that won the race
   *  names its own close. A person's Yes and Orca's allow record the same result. */
  async answer(input: {
    dispatchId: string
    approvalId: string
    decision: WorkerApprovalDecision
    message: string
  }): Promise<TerminalWorkerApprovalAnswer> {
    const notOpen: TerminalWorkerApprovalAnswer = {
      ok: false,
      code: 'approval_not_open',
      message: `This prompt is no longer open: ${input.approvalId} was answered, or left the worker's screen.`
    }
    const hold = this.byApprovalId.get(input.approvalId)
    if (!hold || hold.dispatch.id !== input.dispatchId || !this.stillBound(hold)) {
      return notOpen
    }
    const before = await firstWithin(this.deps.setTimer, () => this.deps.readScreen(hold.paneKey))
    if (hold.state !== 'open' || !before || !showsClaudeDialog(before)) {
      return notOpen
    }
    hold.state = 'answering'
    hold.timer?.cancel()
    const written = await hold.channel.answer(
      input.decision === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: input.message }
    )
    const result = written ? await this.toolResult(hold) : null
    const ours = input.decision === 'deny' ? 'hook-denied' : 'ran'
    if (!result || claudeToolClose(result, input.message) !== ours || hold.state !== 'answering') {
      // A quit or budget end that closed it meanwhile stays closed: the state only moves forward.
      if (hold.state === 'answering') {
        hold.state = 'open'
        await this.settle(hold, result)
      }
      return notOpen
    }
    hold.state = 'answered'
    this.release(hold)
    return { ok: true, approval: this.payload(hold) }
  }

  private watchDialog(hold: Hold): void {
    hold.timer = this.deps.setTimer(() => {
      if (hold.state !== 'open') {
        return
      }
      const lines = this.deps.readScreen(hold.paneKey)
      const shown = lines ? showsClaudeDialog(lines) : null
      if (shown === false && hold.dialogSeen) {
        void this.toolResult(hold).then((result) => this.settle(hold, result))
        return
      }
      hold.dialogSeen ||= shown === true
      this.readDialog(hold, lines)
      this.watchDialog(hold)
    }, DIALOG_POLL_MS)
  }

  /** A hang-up is not an answer: a killed or crashed hook leaves the dialog up (probes F6, F11). */
  private async ended(hold: Hold, why: ClaudePermissionHoldEnd): Promise<void> {
    if (why !== 'hook-gone' || hold.state !== 'open') {
      this.close(hold, null)
      return
    }
    await this.settle(hold, await this.toolResult(hold))
  }

  /** Names a close from this call's tool_result; with none yet, from whether the dialog is still up. */
  private async settle(hold: Hold, result: ClaudeToolResult | null): Promise<void> {
    if (hold.state !== 'open') {
      return
    }
    const close = hold.ranSeen ? 'ran' : result && claudeToolClose(result, null)
    if (close) {
      this.close(hold, CLOSE_OF[close])
      return
    }
    const lines = await firstWithin(this.deps.setTimer, () => this.deps.readScreen(hold.paneKey))
    if (hold.state !== 'open') {
      return
    }
    if (!lines || showsClaudeDialog(lines)) {
      // The dialog is up but Orca can no longer answer it: a person must, in the terminal.
      this.close(hold, { by: 'terminal-only', decision: null })
    } else {
      this.closeAwaitingEvidence(hold)
    }
  }

  /** Closes the card at once; the tool's result, if it comes, only names how in a second line. */
  private closeAwaitingEvidence(hold: Hold): void {
    const reported = hold.reported
    this.close(hold, null)
    if (!reported) {
      return
    }
    hold.refinable = true
    this.closingByToolUseId.set(hold.toolUseId, hold)
    hold.timer = this.deps.setTimer(() => this.close(hold, null), CLOSE_EVIDENCE_MS)
  }

  /** Claude's countdown and its warning, from the first screen that shows them. */
  private readDialog(hold: Hold, lines: readonly string[] | null): void {
    hold.expiresAt ??= claudeDialogExpiresAt(lines, this.deps.now())
    hold.summary.reason ??= claudeDialogWarning(lines)
  }

  /** Ends a record not answered through Orca; a reported one gets its one closing line. */
  private close(hold: Hold, how: CloseHow | null): void {
    if (hold.state === 'answered') {
      return
    }
    hold.state = 'closed'
    this.release(hold)
    this.closingByToolUseId.delete(hold.toolUseId)
    void hold.channel.answer(null)
    const refines = hold.refinable
    hold.refinable = false
    if (!(hold.reported || (refines && how))) {
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
      this.deps,
      refines
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

  /** Still the worker, Dispatch and process run the prompt was raised in. */
  private stillBound(hold: Hold): boolean {
    const worker = this.deps.resolveWorker(hold.paneKey)
    return (
      worker?.dispatch.id === hold.dispatch.id &&
      worker.handle === hold.handle &&
      this.deps.processIncarnation(hold.handle) === hold.incarnation
    )
  }

  private toolResult(hold: Hold): Promise<ClaudeToolResult | null> {
    return firstWithin(this.deps.setTimer, () => this.deps.readToolResult(hold))
  }

  private payload(hold: Hold, outcome?: WorkerApprovalOutcome): WorkerApprovalPayload {
    const open: WorkerApprovalPayload = {
      v: 1,
      approvalId: hold.approvalId,
      state: 'open',
      worker: { handle: hold.handle, dispatchId: hold.dispatch.id, taskId: hold.dispatch.task_id },
      summary: hold.summary,
      allowedActions: ['allow', 'deny'],
      ...(hold.expiresAt ? { expiresAt: hold.expiresAt } : {})
    }
    return outcome ? closedApproval(open, outcome) : open
  }
}
