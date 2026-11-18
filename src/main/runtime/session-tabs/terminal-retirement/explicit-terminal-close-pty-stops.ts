import { IMMEDIATE_KILL_REPLY_BUDGET_MS } from '../../../daemon/sessions/immediate-kill-reply-budget'
import { OrcaRuntimeWithFocusTerminal } from '../../terminal/focus/focus-terminal'

import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { errorMessage } from '../../../../shared/errors/error-message'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import type { RuntimeTerminalClose } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { describeMobileSessionTabCloseRefusal } from '../../session-lifecycle/close/mobile-session-tab-close-refusal-message'
import { isTerminalTabPinnedInSession } from './paired-host-terminal-close'

// Include immediate-kill and follow-up inventory budgets; agent exit hooks can delay verification.
const EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS = IMMEDIATE_KILL_REPLY_BUDGET_MS + 2_000

/** How an explicit close's stop of its addressed PTY ended. */
export type ExplicitCloseStop = { stopped: boolean }

/** Incarnation each PTY id named when the close was asked; undefined means it had no record yet. */
export type OwedPtyIncarnations = ReadonlyMap<string, PtyIncarnationId | null | undefined>

export const NO_STOP: ExplicitCloseStop = { stopped: false }

// Unknown to known is the same process registering its incarnation, as registration treats it.
function isSuccessor(
  expected: PtyIncarnationId | null | undefined,
  current: PtyIncarnationId | null | undefined
): boolean {
  return expected != null && current != null && current !== expected
}

export abstract class OrcaRuntimeWithExplicitCloseTabPtyStops extends OrcaRuntimeWithFocusTerminal {
  /** Captured before asking the window, so a failed close never stops a successor reusing a PTY id. */
  protected captureOwedPtyStops(ptyIds: Iterable<string>): OwedPtyIncarnations {
    return new Map([...ptyIds].map((ptyId) => [ptyId, this.ptysById.get(ptyId)?.incarnationId]))
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

  protected isTabPinnedInAnySession(worktreeId: string, tabId: string): boolean {
    return this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId).some((hostId) =>
      isTerminalTabPinnedInSession(this.store?.getWorkspaceSession?.(hostId), { worktreeId, tabId })
    )
  }

  /** Main owns these PTYs once it asked the window to close their tab; only a pinned tab may keep them running. */
  protected async stopOwedPtysThenRethrow(
    error: unknown,
    target: { worktreeId: string; tabId: string },
    owed: OwedPtyIncarnations,
    addressedPtyId: string
  ): Promise<never> {
    const refused = error instanceof Error && error.message === 'terminal_tab_pinned'
    if (!refused && !this.isTabPinnedInAnySession(target.worktreeId, target.tabId)) {
      await this.stopExplicitlyClosedTabPtys([...owed.keys()], addressedPtyId, owed)
    }
    throw error
  }

  /** Each tab close leaves PTY teardown to main: a close that fails midway still owes the attempted tabs' stops. */
  protected async closeWorktreeTabsOwingPtyStops(
    worktreeId: string,
    parentTabIds: readonly string[]
  ): Promise<number> {
    if (parentTabIds.length === 0) {
      return 0
    }
    const owed = new Map<string, PtyIncarnationId | null | undefined>()
    const ptyIdsByTab = this.getPtyIdsByTabForExplicitClose(worktreeId)
    for (const parentTabId of parentTabIds) {
      for (const [ptyId, incarnationId] of this.captureOwedPtyStops(
        ptyIdsByTab.get(parentTabId) ?? []
      )) {
        owed.set(ptyId, incarnationId)
      }
      try {
        const result = await this.closeMobileSessionTab(`id:${worktreeId}`, parentTabId, {
          reason: 'user',
          force: true,
          localPtyTeardownOwnedExternally: true
        })
        if (result.refused) {
          throw new Error(describeMobileSessionTabCloseRefusal(result.refusalReason))
        }
      } catch (error) {
        // Graph-free: the window that held the tabs may be the thing that went away.
        await this.stopExplicitlyClosedTabPtys([...owed.keys()], '', owed)
        throw error
      }
    }
    return parentTabIds.length
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
      if (isSuccessor(expectedIncarnationId, this.ptysById.get(ptyId)?.incarnationId)) {
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
          const replaced = isSuccessor(
            expectedIncarnationId,
            this.ptysById.get(ptyId)?.incarnationId
          )
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
