import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import {
  closePairedHostLeafFirst,
  isTerminalTabPinnedInSession
} from './paired-host-terminal-close'
import { OrcaRuntimeWithFocusTerminal } from '../terminal/focus/focus-terminal'
import { EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS } from '../orca-runtime-core'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../shared/pty-liveness-verdict'
import { errorMessage } from '../../../shared/error-message'

/** How an explicit close's stop of its addressed PTY ended. */
export type ExplicitCloseStop = { stopped: boolean }

export const NO_STOP: ExplicitCloseStop = { stopped: false }

export abstract class OrcaRuntimeWithExplicitCloseTabPtyStops extends OrcaRuntimeWithFocusTerminal {
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

  /** null when this machine owns the PTY; see `closePairedHostLeafFirst` otherwise. */
  protected closeOnOwningPairedHost(
    handle: string,
    leaf: { worktreeId: string; tabId: string; leafId: string; ptyId: string | null },
    method: 'terminal.close' | 'terminal.closeTab',
    closesTab: boolean
  ): ReturnType<typeof closePairedHostLeafFirst> {
    return closePairedHostLeafFirst(leaf, method, {
      call: (environmentId, hostMethod, params, timeoutMs) =>
        this.callOrchestrationWorkerServer(environmentId, hostMethod, params, timeoutMs),
      isTabPinned: () =>
        closesTab &&
        this.getWorkspaceSessionHostIdsForTab(leaf.worktreeId, leaf.tabId).some((hostId) =>
          isTerminalTabPinnedInSession(this.store?.getWorkspaceSession?.(hostId), leaf)
        ),
      readBoundLeaf: () => this.getLiveLeafForHandle(handle).leaf
    })
  }

  protected async stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string,
    beforeAction?: () => void
  ): Promise<ExplicitCloseStop> {
    let addressedPtyStop = NO_STOP
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const ptyId of ptyIds) {
      beforeAction?.()
      this.markPtyStopRequested(ptyId)
      const expectedIncarnationId = this.ptysById.get(ptyId)?.incarnationId
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
          if (!providerAlreadyRetiredPty) {
            beforeAction?.()
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
