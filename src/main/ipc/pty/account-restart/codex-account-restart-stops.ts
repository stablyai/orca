import type {
  CodexAccountRestartNotStartedReason,
  CodexAccountRestartStopRequest,
  CodexAccountRestartStopResult,
  CodexAccountRestartWithdrawRequest
} from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'
import type {
  CodexAccountRestartStopDeps,
  CodexRestartExitClassification,
  CodexRestartExitObservation,
  CodexRestartOccupant,
  CodexRestartProvenance,
  CodexRestartResumeDecision,
  CodexRestartStopOutcome
} from './codex-account-restart-types'
import { isValidRestartRequest, isSameRestartOccupant } from './codex-account-restart-types'

export type {
  CodexAccountRestartNotStartedReason,
  CodexAccountRestartStopDeps,
  CodexAccountRestartStopRequest,
  CodexAccountRestartStopResult,
  CodexRestartExitClassification,
  CodexRestartExitObservation,
  CodexRestartOccupant,
  CodexRestartProvenance,
  CodexRestartResumeDecision,
  CodexRestartStopOutcome
}

import {
  CodexAccountRestartMarks,
  codexAccountRestartPaneKey,
  isDelivered,
  type RestartMark
} from './codex-account-restart-marks'

export { codexAccountRestartPaneKey }

type InFlightStop = {
  mark: RestartMark
  result: Promise<CodexAccountRestartStopResult>
}

/** Main's one register of account-restart stops: admission, exit classification and the resume gate. */
export class CodexAccountRestartStops extends CodexAccountRestartMarks {
  private readonly inFlightByPane = new Map<string, InFlightStop>()

  /** Admits one stop per pane; a second request for the same pane joins the stop in flight. */
  request(
    request: CodexAccountRestartStopRequest,
    deps: CodexAccountRestartStopDeps
  ): Promise<CodexAccountRestartStopResult> {
    if (!isValidRestartRequest(request)) {
      return Promise.resolve({
        outcome: 'not-started',
        reason: 'invalid',
        opIds: []
      })
    }
    const paneKey = codexAccountRestartPaneKey(request)
    const inFlight = this.inFlightByPane.get(paneKey)
    if (inFlight) {
      inFlight.mark.opIds.add(request.opId)
      // A click after Dismiss is the newer answer for the same pane.
      inFlight.mark.withdrawn = false
      return inFlight.result
    }
    const occupant = deps.resolveOccupant(request)
    if (typeof occupant === 'string') {
      return Promise.resolve({
        outcome: 'not-started',
        reason: occupant,
        opIds: [request.opId]
      })
    }
    // A Retry on the same process inherits the earlier attempt's possible effect and delivered exit.
    const previous = this.markByPane.get(paneKey)
    const sameProcess = previous?.incarnationId === occupant.incarnationId ? previous : undefined
    let settle!: () => void
    const mark: RestartMark = {
      paneKey,
      ptyId: occupant.ptyId,
      incarnationId: occupant.incarnationId,
      provenance: occupant.provenance,
      opIds: new Set([request.opId]),
      runtimeDelivered: sameProcess?.runtimeDelivered ?? false,
      rendererDelivered: sameProcess?.rendererDelivered ?? false,
      writerProof: false,
      withdrawn: false,
      earlierEffectPossible: sameProcess?.earlierEffectPossible ?? false,
      state: 'pending',
      settled: new Promise<void>((resolve) => {
        settle = resolve
      })
    }
    this.installMark(mark)
    const result = this.runStop(request, occupant, mark, deps).finally(() => {
      this.inFlightByPane.delete(paneKey)
      settle()
    })
    this.inFlightByPane.set(paneKey, { mark, result })
    return result
  }
  /** Dismiss: fenced by pane and operation; a stale opId changes nothing. */
  withdraw(request: CodexAccountRestartWithdrawRequest): boolean {
    if (typeof request?.opId !== 'string') {
      return false
    }
    const paneKey = codexAccountRestartPaneKey(request)
    const mark = this.markByPane.get(paneKey) ?? this.spentMarkByPane.get(paneKey)
    if (!mark || !mark.opIds.has(request.opId)) {
      return false
    }
    mark.withdrawn = true
    if (mark.state === 'ready') {
      mark.state = 'withdrawn'
    }
    return true
  }
  private async runStop(
    request: CodexAccountRestartStopRequest,
    occupant: CodexRestartOccupant,
    mark: RestartMark,
    deps: CodexAccountRestartStopDeps
  ): Promise<CodexAccountRestartStopResult> {
    // Yield once so a same-tick second click or Dismiss lands before the stop is authorized.
    await Promise.resolve()
    let denial = this.authorizationDenial(request, occupant, mark, deps)
    const authorize = (): boolean => {
      denial = this.authorizationDenial(request, occupant, mark, deps)
      return denial === null
    }
    let outcome: CodexRestartStopOutcome | 'not-authorized' = 'not-authorized'
    if (denial === null) {
      try {
        outcome = await deps.stop(occupant, authorize)
      } catch {
        outcome = 'unknown'
      }
    }
    if (outcome === 'not-authorized') {
      // A stale choice at the authorization boundary sends zero stop requests.
      this.retireUnlessEarlierEffect(mark)
      return { outcome: 'not-started', reason: denial ?? 'superseded', opIds: [...mark.opIds] }
    }
    const opIds = [...mark.opIds]
    if ((outcome === 'refused' || outcome === 'service-outdated') && !isDelivered(mark)) {
      this.retireUnlessEarlierEffect(mark)
      return { outcome: 'not-started', reason: outcome, opIds }
    }
    if (outcome === 'ended') {
      mark.writerProof = true
    }
    if (outcome === 'unknown') {
      mark.earlierEffectPossible = true
    }
    // Host loss and ambiguous attempts are never proof: the resume stays on the pinned account.
    mark.state = mark.writerProof && !mark.withdrawn ? 'ready' : 'withdrawn'
    return mark.writerProof ? { outcome: 'stopped', opIds } : { outcome: 'unknown', opIds }
  }
  /** Null when the user's answer and the pane's occupant still stand; otherwise why not. */
  private authorizationDenial(
    request: CodexAccountRestartStopRequest,
    occupant: CodexRestartOccupant,
    mark: RestartMark,
    deps: CodexAccountRestartStopDeps
  ): CodexAccountRestartNotStartedReason | null {
    if (mark.withdrawn) {
      return 'withdrawn'
    }
    const recheck = deps.resolveOccupant(request)
    if (typeof recheck === 'string') {
      return recheck
    }
    return isSameRestartOccupant(recheck, occupant) ? null : 'superseded'
  }
  // A refused Retry must not erase an earlier ambiguous attempt: its late exit is still a restart exit.
  private retireUnlessEarlierEffect(mark: RestartMark): void {
    if (mark.earlierEffectPossible) {
      mark.state = 'withdrawn'
      return
    }
    this.retireMark(mark)
  }
}

export const codexAccountRestartStops = new CodexAccountRestartStops()
