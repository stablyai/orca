import { IMMEDIATE_KILL_REPLY_BUDGET_MS } from '../../daemon/sessions/immediate-kill-reply-budget'
import { OrcaRuntimeWithFocusTerminal } from '../terminal/focus/focus-terminal'

import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { errorMessage } from '../../../shared/errors/error-message'
import type { PtyIncarnationId } from '../../../shared/terminal/pty/lifecycle/pty-incarnation'
// Include immediate-kill and follow-up inventory budgets; agent exit hooks can delay verification.
const EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS = IMMEDIATE_KILL_REPLY_BUDGET_MS + 2_000

/** How an explicit close's stop of its addressed PTY ended. */
export type ExplicitCloseStop = { stopped: boolean }

/** Incarnation each PTY id named when the close was asked; undefined means it had no record yet. */
export type OwedPtyIncarnations = ReadonlyMap<string, PtyIncarnationId | null | undefined>

export const NO_STOP: ExplicitCloseStop = { stopped: false }

export abstract class OrcaRuntimeWithExplicitCloseTabPtyStops extends OrcaRuntimeWithFocusTerminal {
  /** Captured before asking the window, so a failed close never stops a successor reusing a PTY id. */
  protected captureOwedPtyStops(ptyIds: Iterable<string>): OwedPtyIncarnations {
    return new Map([...ptyIds].map((ptyId) => [ptyId, this.ptysById.get(ptyId)?.incarnationId]))
  }

  protected async stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string,
    owedIncarnations?: OwedPtyIncarnations
  ): Promise<ExplicitCloseStop> {
    let addressedPtyStop = NO_STOP
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const ptyId of ptyIds) {
      const expectedIncarnationId = owedIncarnations?.has(ptyId)
        ? owedIncarnations.get(ptyId)
        : this.ptysById.get(ptyId)?.incarnationId
      // A successor reusing this id is not what the close asked to stop.
      if (this.ptysById.get(ptyId)?.incarnationId !== expectedIncarnationId) {
        continue
      }
      this.markPtyStopRequested(ptyId)
      let stopped = false
      if (this.ptyController?.stopAndWait) {
        try {
          stopped = await this.ptyController.stopAndWait(ptyId, { deadlineMs })
        } catch (error) {
          this.markPtyLivenessUnverifiable(ptyId, errorMessage(error))
        }
        // Preserve an observed exit when a broader inventory check could not finish.
        if (
          !stopped &&
          expectedIncarnationId &&
          this.ptysById.get(ptyId)?.incarnationId === expectedIncarnationId &&
          this.getPtyLivenessVerdict(ptyId)?.status === 'exited'
        ) {
          stopped = true
        }
        if (!stopped) {
          const verdict = this.getPtyLivenessVerdict(ptyId)
          const providerAlreadyRetiredPty =
            verdict?.status === 'unverifiable' &&
            verdict.reason === SSH_PROVIDER_UNREGISTERED_REASON
          const current = this.ptysById.get(ptyId)
          const replaced = current !== undefined && current.incarnationId !== expectedIncarnationId
          if (!providerAlreadyRetiredPty && !replaced) {
            this.ptyController.kill(ptyId)
            if (!verdict || verdict.status === 'live') {
              this.markPtyLivenessUnverifiable(
                ptyId,
                'a follow-up stop was issued but its outcome could not be verified'
              )
            }
          }
        }
      } else {
        stopped = this.ptyController?.kill(ptyId) ?? false
      }
      if (ptyId === addressedPtyId) {
        addressedPtyStop = { stopped }
      }
    }
    return addressedPtyStop
  }
}
