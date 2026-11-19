/** Claude terminal workers' permission prompts, one record per waiting PermissionRequest hook. A lead's
 *  record is answerable only while its hook waits and Claude's dialog is on the worker's screen. A helper
 *  agent's dialog is drawn only once its hooks return, so its record never reads the screen: it is
 *  reported on its own, answered through its hook, and closed from the helper's own transcript. */
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
import { claudeToolCloseHow, type ClaudeToolRecord } from './claude-tool-result-close'
import { firstWithin } from './first-within'
import {
  claudeTookAnswer,
  droppedAllowRefusal,
  holdPayload,
  type TerminalWorkerApprovalAnswer,
  type TerminalWorkerApprovalCloseHow,
  type TerminalWorkerApprovalHold
} from './terminal-worker-approval-hold'
import type {
  WorkerApprovalDecision,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import { TERMINAL_APPROVAL_ID_PREFIX } from './worker-approval-report'
import { TerminalWorkerApprovalBook } from './terminal-worker-approval-book'
import {
  findHelperHold,
  orcaMayHoldHelper,
  promptSummary,
  promptTranscriptPath,
  reportHelperPrompt
} from './terminal-helper-approval-hold'

// Why 500 ms: Esc posts no hook, so only the screen says the dialog left; a click is refused within it.
const DIALOG_POLL_MS = 500

type Hold = TerminalWorkerApprovalHold
type CloseHow = TerminalWorkerApprovalCloseHow
// Its tool ran, failed or not: it was allowed in the terminal.
const RAN: CloseHow = { by: 'worker-terminal', decision: 'allow' }
const TERMINAL_ONLY: CloseHow = { by: 'terminal-only', decision: null }

export class TerminalWorkerApprovalHolds
  extends TerminalWorkerApprovalBook
  implements ClaudePermissionHolds
{
  admit(request: ClaudePermissionHold): boolean {
    const { event, promptId } = request
    const { paneKey, toolUseId } = event
    const helper = event.toolAgentId
    const transcriptPath = promptTranscriptPath(event)
    // No single open call matches it, or no transcript can say how it closed.
    if (!toolUseId || !promptId || !transcriptPath) {
      return false
    }
    const worker = this.deps.canAnswerPane(paneKey) ? this.deps.resolveWorker(paneKey) : null
    if (!worker) {
      return false
    }
    if (helper === undefined) {
      const other = this.openByPane.get(paneKey)
      if (other) {
        // Two prompts in one pane: the screen cannot say which one it shows, so neither is answerable.
        this.close(other, TERMINAL_ONLY)
        return false
      }
    } else if (!orcaMayHoldHelper(this.deps, worker)) {
      return false
    }
    const hold: Hold = {
      approvalId: `${TERMINAL_APPROVAL_ID_PREFIX}${createHash('sha256')
        .update(JSON.stringify([promptId, toolUseId]))
        .digest('hex')
        .slice(0, 16)}`,
      paneKey,
      ...(helper !== undefined ? { helper } : {}),
      toolUseId,
      transcriptPath,
      handle: worker.handle,
      incarnation: this.deps.processIncarnation(worker.handle),
      db: worker.db,
      dispatch: worker.dispatch,
      summary: promptSummary(event),
      channel: request.openChannel(),
      state: 'open',
      dialogSeen: false,
      refinable: false,
      ranSeen: false,
      reported: false,
      timer: null
    }
    this.byApprovalId.set(hold.approvalId, hold)
    hold.channel.onEnd((why) => void this.ended(hold, why))
    if (helper === undefined) {
      this.openByPane.set(paneKey, hold)
      this.watchDialog(hold)
    } else if (!reportHelperPrompt(hold, this.deps)) {
      // No card went out: let Claude show it in the terminal at once.
      this.close(hold, null)
    }
    return true
  }

  /** The held prompt this tool call asks about, lead's or helper's. */
  private heldCall(paneKey: string, toolUseId: string): Hold | undefined {
    const lead = this.openByPane.get(paneKey)
    if (lead?.toolUseId === toolUseId) {
      return lead
    }
    return (
      findHelperHold(this.byApprovalId.values(), paneKey, (hold) => hold.toolUseId === toolUseId) ??
      this.closingByToolUseId.get(toolUseId)
    )
  }

  /** Every accepted Claude event: a tool's result says how a dialog closed. */
  observe(event: AgentHookEventPayload): void {
    // A failed command ran too: it was allowed.
    const ran =
      event.hookEventName === 'PostToolUse' || event.hookEventName === 'PostToolUseFailure'
    if (ran && event.toolUseId) {
      const hold = this.heldCall(event.paneKey, event.toolUseId)
      if (hold?.paneKey !== event.paneKey) {
        return
      }
      hold.ranSeen = true
      if (hold.state !== 'answering') {
        this.close(hold, RAN)
      }
      return
    }
    // An agent's turn ended: whatever closed its dialog left no result to name. Helpers outlive the lead's turns.
    const ended =
      event.hookEventName === 'Stop' ||
      event.hookEventName === 'StopFailure' ||
      event.hookEventName === 'SubagentStop'
    if (ended) {
      for (const hold of this.closingByToolUseId.values()) {
        if (hold.paneKey === event.paneKey && hold.helper === event.toolAgentId) {
          // One last read: a result written late still names the close.
          void this.deps
            .readToolRecord(hold)
            .then((record) => this.close(hold, claudeToolCloseHow(record?.result ?? null)))
        }
      }
    }
  }

  /** Its escalation went out, so its close owes the coordinator one closing line. */
  markReported(approvalId: string): void {
    const hold = this.byApprovalId.get(approvalId)
    if (hold) {
      hold.reported = true
    }
  }

  /** Whether Orca still holds this prompt's hook, answering or not. */
  isHeld(approvalId: string): boolean {
    return this.byApprovalId.has(approvalId)
  }

  /** The open approval this pane's worker waits on, for its stop's escalation: the lead's, else a
   *  helper's, whose own card already went out under the same id. A dialog on screen is never a held
   *  helper's, so with one up the stop is reported as the unheld prompt it is. */
  async takeOpenApproval(
    paneKey: string,
    dispatchId: string
  ): Promise<WorkerApprovalPayload | null> {
    const hold = this.openByPane.get(paneKey)
    if (hold?.state !== 'open' || hold.dispatch.id !== dispatchId) {
      const screen = this.deps.readScreen(paneKey)
      if (!screen || showsClaudeDialog(screen)) {
        return null
      }
      const helper = findHelperHold(
        this.byApprovalId.values(),
        paneKey,
        (held) => held.state === 'open' && held.dispatch.id === dispatchId
      )
      return helper ? holdPayload(helper) : null
    }
    // The escalation can go out before the dialog paints: wait for it, for its countdown and reason.
    const lines = await firstWithin(this.deps.setTimer, () => {
      const screen = this.deps.readScreen(paneKey)
      return screen && showsClaudeDialog(screen) ? screen : null
    })
    if (hold.state !== 'open' || this.openByPane.get(paneKey) !== hold) {
      return null
    }
    this.readDialog(hold, lines)
    return holdPayload(hold)
  }

  /** Writes a decision only to a dialog still on a caught-up screen, and claims it once the dialog
   *  leaves: Claude takes a hook's answer at once, but records an allow only with the tool's result,
   *  which a long command delays. A dialog that stays, or a record already naming a Yes, a No or the
   *  2:00 auto-block that won the race, refuses it; a record written later only corrects the receipt. */
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
    // A helper's dialog is never drawn while Orca holds its hook: only a lead's screen is read first.
    const before =
      hold.helper === undefined
        ? await firstWithin(this.deps.setTimer, () => this.deps.readScreen(hold.paneKey))
        : null
    if (
      hold.state !== 'open' ||
      (hold.helper === undefined && !(before && showsClaudeDialog(before)))
    ) {
      return notOpen
    }
    // The escalation can go out before Claude paints its warning: read it from this screen too.
    this.readDialog(hold, before)
    const personOnly = droppedAllowRefusal(hold, input)
    if (personOnly) {
      return personOnly
    }
    hold.state = 'answering'
    hold.timer?.cancel()
    const written = await hold.channel.answer(
      input.decision === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: input.message }
    )
    const { taken, record } = written
      ? await claudeTookAnswer(hold, this.deps, input)
      : { taken: false, record: null }
    if (!taken || hold.state !== 'answering') {
      // A quit or budget end that closed it meanwhile stays closed: the state only moves forward.
      if (hold.state === 'answering') {
        hold.state = 'open'
        await this.settle(hold, record)
      }
      return droppedAllowRefusal(hold, input) ?? notOpen
    }
    hold.state = 'answered'
    hold.answeredWith = input.decision
    this.release(hold)
    if (!record?.result && !hold.ranSeen) {
      // Its tool still runs: only its result can still say a person or the auto-block won the race.
      this.awaitEvidence(hold)
    }
    return { ok: true, approval: holdPayload(hold) }
  }

  private watchDialog(hold: Hold): void {
    hold.timer = this.deps.setTimer(() => {
      if (hold.state !== 'open') {
        return
      }
      const lines = this.deps.readScreen(hold.paneKey)
      const shown = lines ? showsClaudeDialog(lines) : null
      if (shown === false && hold.dialogSeen) {
        void this.toolRecord(hold).then((record) => this.settle(hold, record))
        return
      }
      hold.dialogSeen ||= shown === true
      this.readDialog(hold, lines)
      this.watchDialog(hold)
    }, DIALOG_POLL_MS)
  }

  /** A hang-up is not an answer: a killed or crashed hook leaves the dialog up (probes F6, F11). */
  private async ended(hold: Hold, why: ClaudePermissionHoldEnd): Promise<void> {
    if (why === 'budget' && hold.helper !== undefined && hold.state === 'open') {
      // Unanswered in Orca: Claude now shows it in the worker's terminal, unless its record already closed it.
      const record = await this.toolRecord(hold)
      if (hold.state === 'open') {
        this.close(hold, claudeToolCloseHow(record?.result ?? null) ?? TERMINAL_ONLY)
      }
      return
    }
    if (why !== 'hook-gone' || hold.state !== 'open') {
      this.close(hold, null)
      return
    }
    await this.settle(hold, await this.toolRecord(hold))
  }

  /** Names a close from this call's tool_result; with none yet, from whether the dialog is still up. */
  private async settle(hold: Hold, record: ClaudeToolRecord | null): Promise<void> {
    if (hold.state !== 'open') {
      return
    }
    const how = hold.ranSeen ? RAN : claudeToolCloseHow(record?.result ?? null)
    if (how) {
      this.close(hold, how)
      return
    }
    const lines =
      hold.helper === undefined
        ? await firstWithin(this.deps.setTimer, () => this.deps.readScreen(hold.paneKey))
        : null
    if (hold.state !== 'open') {
      return
    }
    if (!this.stillBound(hold)) {
      // Stopped, exited or handed on: no terminal is left to answer it in.
      this.close(hold, { by: 'worker-ended', decision: null })
    } else if (hold.helper === undefined && (!lines || showsClaudeDialog(lines))) {
      // The dialog is up but Orca can no longer answer it: a person must, in the terminal.
      this.close(hold, TERMINAL_ONLY)
    } else {
      this.closeAwaitingEvidence(hold)
    }
  }

  /** Claude's countdown and its warning, from the first screen that shows them. */
  private readDialog(hold: Hold, lines: readonly string[] | null): void {
    hold.expiresAt ??= claudeDialogExpiresAt(lines, this.deps.now())
    hold.summary.reason ??= claudeDialogWarning(lines)
  }
}
