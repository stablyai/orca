import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import { OrcaRuntimeWithFocusTerminal } from '../terminal/focus/focus-terminal'
import { EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS } from '../orca-runtime-core'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../shared/pty-liveness-verdict'
import { errorMessage } from '../../../shared/error-message'

/** How an explicit close's stop of its addressed PTY ended. */
export type ExplicitCloseStop = { stopped: boolean }

export const NO_STOP: ExplicitCloseStop = { stopped: false }

export abstract class OrcaRuntimeWithExplicitCloseTabPtyStops extends OrcaRuntimeWithFocusTerminal {
  protected async stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string,
    capturedIncarnationId?: string
  ): Promise<ExplicitCloseStop> {
    let addressedPtyStop = NO_STOP
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const ptyId of ptyIds) {
      this.markPtyStopRequested(ptyId)
      const expectedIncarnationId = capturedIncarnationId ?? this.ptysById.get(ptyId)?.incarnationId
      const current = this.ptysById.get(ptyId)
      const replacement = this.pendingPtyHandleReplacementFences.get(ptyId)
      let stopped =
        !!capturedIncarnationId &&
        (!current || current.incarnationId === capturedIncarnationId) &&
        (!replacement || replacement.incarnationId === capturedIncarnationId) &&
        this.getPtyLivenessVerdict(ptyId)?.status === 'exited'
      const settle = capturedIncarnationId
        ? this.intentionalPtyStops.mark(ptyId, 'closing', capturedIncarnationId)
        : null
      try {
        if (!stopped && this.ptyController?.stopAndWait) {
          try {
            stopped = await this.ptyController.stopAndWait(ptyId, {
              deadlineMs,
              ...(capturedIncarnationId ? { expectedIncarnationId: capturedIncarnationId } : {})
            })
          } catch (error) {
            this.markPtyLivenessUnverifiable(ptyId, errorMessage(error))
          }
          // Preserve an observed exit when a broader inventory check could not finish.
          if (
            !stopped &&
            expectedIncarnationId &&
            (!this.ptysById.has(ptyId) ||
              this.ptysById.get(ptyId)?.incarnationId === expectedIncarnationId) &&
            (!this.pendingPtyHandleReplacementFences.has(ptyId) ||
              this.pendingPtyHandleReplacementFences.get(ptyId)?.incarnationId ===
                expectedIncarnationId) &&
            this.getPtyLivenessVerdict(ptyId)?.status === 'exited'
          ) {
            stopped = true
          }
          if (!stopped && !capturedIncarnationId) {
            const verdict = this.getPtyLivenessVerdict(ptyId)
            const providerAlreadyRetiredPty =
              verdict?.status === 'unverifiable' &&
              verdict.reason === SSH_PROVIDER_UNREGISTERED_REASON
            if (!providerAlreadyRetiredPty) {
              this.ptyController.kill(ptyId)
              if (!verdict || verdict.status === 'live') {
                this.markPtyLivenessUnverifiable(
                  ptyId,
                  'a follow-up stop was issued but its outcome could not be verified'
                )
              }
            }
          }
        } else if (!capturedIncarnationId) {
          stopped = this.ptyController?.kill(ptyId) ?? false
        }
      } finally {
        settle?.(stopped)
        if (capturedIncarnationId && !stopped) {
          this.clearPtyStopRequest(ptyId)
        }
      }
      if (ptyId === addressedPtyId) {
        addressedPtyStop = { stopped }
      }
    }
    return addressedPtyStop
  }

  protected describeTerminalClose(
    handle: string,
    tabId: string,
    ptyId: string | null,
    stop: ExplicitCloseStop
  ): RuntimeTerminalClose {
    const close: RuntimeTerminalClose = { handle, tabId, ptyKilled: stop.stopped }
    if (stop.stopped || !ptyId) {
      return close
    }
    const verdict = this.getPtyLivenessVerdict(ptyId)
    if (verdict?.status === 'unverifiable') {
      return { ...close, ptyStopVerdict: 'unverifiable', ptyStopReason: verdict.reason }
    }
    if (verdict?.status === 'live') {
      return { ...close, ptyStopVerdict: 'live' }
    }
    return close
  }
}
