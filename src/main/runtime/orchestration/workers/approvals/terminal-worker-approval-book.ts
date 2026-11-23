/** Every held prompt Orca knows, and how one closes when Orca did not answer it: at once, with one
 *  closing line if it was reported, and a second line once its tool's result names how. */
import { firstWithin } from './first-within'
import type { ClaudeToolRecord } from './claude-tool-result-close'
import {
  reportHoldClosed,
  type TerminalWorkerApprovalCloseHow,
  type TerminalWorkerApprovalHold,
  type TerminalWorkerApprovalHoldsDeps
} from './terminal-worker-approval-hold'

// A closed prompt waits this long for its tool's result before its closing line says no more than "closed".
export const CLOSE_EVIDENCE_MS = 10 * 60_000

type Hold = TerminalWorkerApprovalHold
type CloseHow = TerminalWorkerApprovalCloseHow

export class TerminalWorkerApprovalBook {
  protected readonly byApprovalId = new Map<string, Hold>()
  /** The lead's one open prompt per pane; helpers' prompts are never on screen, so never counted here. */
  protected readonly openByPane = new Map<string, Hold>()
  /** Closed by the dialog, awaiting the tool's result to say how. */
  protected readonly closingByToolUseId = new Map<string, Hold>()

  constructor(protected readonly deps: TerminalWorkerApprovalHoldsDeps) {}

  /** Closes the card at once; the tool's result, if it comes, only names how in a second line. */
  protected closeAwaitingEvidence(hold: Hold): void {
    const reported = hold.reported
    this.close(hold, null)
    if (!reported) {
      return
    }
    hold.refinable = true
    this.awaitEvidence(hold)
  }

  protected awaitEvidence(hold: Hold): void {
    this.closingByToolUseId.set(hold.toolUseId, hold)
    hold.timer = this.deps.setTimer(() => this.close(hold, null), CLOSE_EVIDENCE_MS)
  }

  /** Ends a record not answered through Orca; a reported one gets its one closing line. */
  protected close(hold: Hold, how: CloseHow | null): void {
    if (hold.state === 'answered') {
      // Orca's answer stands unless its tool's result names the opposite one.
      if (
        this.closingByToolUseId.delete(hold.toolUseId) &&
        how?.decision &&
        how.decision !== hold.answeredWith
      ) {
        reportHoldClosed(hold, how, this.deps, true)
      }
      hold.timer?.cancel()
      return
    }
    hold.state = 'closed'
    hold.closedAs = how
    this.release(hold)
    this.closingByToolUseId.delete(hold.toolUseId)
    void hold.channel.answer(null)
    const refines = hold.refinable
    hold.refinable = false
    if (!(hold.reported || (refines && how))) {
      return
    }
    hold.reported = false
    reportHoldClosed(hold, how, this.deps, refines)
  }

  protected release(hold: Hold): void {
    hold.timer?.cancel()
    hold.timer = null
    if (this.openByPane.get(hold.paneKey) === hold) {
      this.openByPane.delete(hold.paneKey)
    }
    this.byApprovalId.delete(hold.approvalId)
  }

  /** Still the worker, Dispatch and process run the prompt was raised in. */
  protected stillBound(hold: Hold): boolean {
    const worker = this.deps.resolveWorker(hold.paneKey)
    return (
      worker?.dispatch.id === hold.dispatch.id &&
      worker.handle === hold.handle &&
      this.deps.processIncarnation(hold.handle) === hold.incarnation
    )
  }

  protected toolRecord(hold: Hold): Promise<ClaudeToolRecord | null> {
    return firstWithin(this.deps.setTimer, () => this.deps.readToolRecord(hold))
  }
}
