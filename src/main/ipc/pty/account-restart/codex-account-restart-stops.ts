import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
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

type RestartIntentState = 'pending' | 'ready' | 'withdrawn'

type RestartMark = {
  paneKey: string
  ptyId: string
  incarnationId: string
  provenance: CodexRestartProvenance
  opIds: Set<string>
  /** Which consumers already received this incarnation's one logical exit. */
  runtimeDelivered: boolean
  rendererDelivered: boolean
  writerProof: boolean
  withdrawn: boolean
  /** An earlier attempt on this incarnation ended ambiguously and may still end the process. */
  earlierEffectPossible: boolean
  state: RestartIntentState
  settled: Promise<void>
}

type InFlightStop = {
  mark: RestartMark
  result: Promise<CodexAccountRestartStopResult>
}

// Bounded by panes, not time: enough to reject late exits after the mark is spent or replaced.
const RETIRED_INCARNATION_LIMIT = 256

export function codexAccountRestartPaneKey(
  request: Pick<CodexAccountRestartStopRequest, 'worktreeId' | 'tabId' | 'leafId'>
): string {
  return `${request.worktreeId}\0${request.tabId}\0${request.leafId}`
}

/** Main's one register of account-restart stops: admission, exit classification and the resume gate. */
export class CodexAccountRestartStops {
  private readonly inFlightByPane = new Map<string, InFlightStop>()
  private readonly markByIncarnation = new Map<string, RestartMark>()
  private readonly markByPane = new Map<string, RestartMark>()
  // A granted intent stays reachable until its launch starts, so Dismiss still applies to it.
  private readonly spentMarkByPane = new Map<string, RestartMark>()
  private readonly retiredIncarnations = new Set<string>()

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

  /** Called at provider-exit ingress, before any runtime, app or renderer consumer sees the exit. */
  classifyExit(
    ptyId: string,
    incarnationId: string | null | undefined,
    observation: CodexRestartExitObservation
  ): CodexRestartExitClassification {
    if (!incarnationId) {
      // Unstamped exits keep baseline semantics and carry no account-switch authority.
      return 'ordinary'
    }
    const mark = this.markByIncarnation.get(incarnationId)
    if (!mark || mark.ptyId !== ptyId) {
      return this.retiredIncarnations.has(incarnationId) ? 'duplicate' : 'ordinary'
    }
    // An attach miss reaches runtime only; stream exits and receipts reach runtime and the renderer.
    const runtimeOwed = !mark.runtimeDelivered
    const rendererOwed = observation !== 'attach-miss' && !mark.rendererDelivered
    mark.runtimeDelivered = true
    mark.rendererDelivered ||= rendererOwed
    if (runtimeOwed) {
      return 'restart'
    }
    return rendererOwed ? 'restart-renderer-only' : 'duplicate'
  }

  /** The single gate every fresh local Codex resume passes; waits for the stop to settle. */
  async resolveResume(args: {
    paneKey: string | null
    providerSession: AgentProviderSessionMetadata | undefined
  }): Promise<CodexRestartResumeDecision> {
    const mark = args.paneKey ? this.markByPane.get(args.paneKey) : undefined
    if (!mark || !args.providerSession || args.providerSession.id !== mark.provenance.threadId) {
      // A different thread cannot borrow this pane's account switch.
      return { kind: 'none' }
    }
    await mark.settled
    if (this.markByPane.get(mark.paneKey) !== mark || mark.state !== 'ready') {
      return { kind: 'pinned' }
    }
    return this.grantSelectedAccountResume(mark, args.providerSession)
  }

  /** A proven restart whose pane comes back without its conversation must fail once, not open a shell. */
  async refusesResumeWithoutConversation(paneKey: string): Promise<boolean> {
    const mark = this.markByPane.get(paneKey)
    if (!mark || mark.withdrawn) {
      return false
    }
    await mark.settled
    if (this.markByPane.get(paneKey) !== mark || mark.state !== 'ready') {
      return false
    }
    this.retireMark(mark)
    return true
  }

  /** Close or rebind of the pane: its intent no longer applies. */
  forgetPane(paneKey: string): void {
    this.spentMarkByPane.delete(paneKey)
    const mark = this.markByPane.get(paneKey)
    if (mark) {
      this.retireMark(mark)
    }
  }

  private grantSelectedAccountResume(
    mark: RestartMark,
    providerSession: AgentProviderSessionMetadata
  ): CodexRestartResumeDecision {
    // Spend the intent now so a concurrent mount cannot launch the same conversation twice.
    this.retireMark(mark)
    this.spentMarkByPane.set(mark.paneKey, mark)
    return {
      kind: 'selected',
      providerSession: {
        ...providerSession,
        transcriptPath: mark.provenance.transcriptPath
      },
      unspend: () => {
        // Only the pane's latest intent comes back, and a Dismiss while it was spent still holds.
        if (this.spentMarkByPane.get(mark.paneKey) !== mark || this.markByPane.has(mark.paneKey)) {
          return
        }
        this.spentMarkByPane.delete(mark.paneKey)
        this.retiredIncarnations.delete(mark.incarnationId)
        this.installMark(mark)
      }
    }
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

  private installMark(mark: RestartMark): void {
    if (this.spentMarkByPane.get(mark.paneKey) !== mark) {
      this.spentMarkByPane.delete(mark.paneKey)
    }
    const previous = this.markByPane.get(mark.paneKey)
    if (previous && previous !== mark) {
      this.retireMark(previous)
    }
    this.markByPane.set(mark.paneKey, mark)
    this.markByIncarnation.set(mark.incarnationId, mark)
  }

  private retireMark(mark: RestartMark): void {
    if (this.markByPane.get(mark.paneKey) === mark) {
      this.markByPane.delete(mark.paneKey)
    }
    if (this.markByIncarnation.get(mark.incarnationId) === mark) {
      this.markByIncarnation.delete(mark.incarnationId)
    }
    if (!isDelivered(mark)) {
      return
    }
    this.retiredIncarnations.add(mark.incarnationId)
    if (this.retiredIncarnations.size > RETIRED_INCARNATION_LIMIT) {
      const oldest = this.retiredIncarnations.values().next().value
      if (oldest !== undefined) {
        this.retiredIncarnations.delete(oldest)
      }
    }
  }
}

export const codexAccountRestartStops = new CodexAccountRestartStops()

function isDelivered(mark: RestartMark): boolean {
  return mark.runtimeDelivered || mark.rendererDelivered
}
