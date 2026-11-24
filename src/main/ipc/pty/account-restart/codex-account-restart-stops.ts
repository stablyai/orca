import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  CodexAccountRestartNotStartedReason,
  CodexAccountRestartStopRequest,
  CodexAccountRestartStopResult,
  CodexAccountRestartWithdrawRequest
} from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'

export type {
  CodexAccountRestartNotStartedReason,
  CodexAccountRestartStopRequest,
  CodexAccountRestartStopResult
}

/** The conversation the stopped process was writing, captured before the stop. */
export type CodexRestartProvenance = {
  threadId: string
  transcriptPath: string
}

export type CodexRestartOccupant = {
  ptyId: string
  incarnationId: string
  provenance: CodexRestartProvenance
}

/** `ended` is the only writer proof; `refused` and `unsupported` are proven pre-signal refusals. */
export type CodexRestartStopOutcome = 'ended' | 'refused' | 'unsupported' | 'unknown'

export type CodexAccountRestartStopDeps = {
  /** Re-derives the pane's eligible occupant from host facts, or the reason it has none. */
  resolveOccupant: (
    request: CodexAccountRestartStopRequest
  ) => CodexRestartOccupant | CodexAccountRestartNotStartedReason
  /** Dispatches the exact-incarnation fenced stop. */
  stop: (occupant: CodexRestartOccupant) => Promise<CodexRestartStopOutcome>
}

export type CodexRestartExitObservation = 'stream' | 'host-loss' | 'fenced-ended'
/** `restart`: the first logical exit of a restart-stopped incarnation; `duplicate`: drop it. */
export type CodexRestartExitClassification = 'ordinary' | 'restart' | 'duplicate'

export type CodexRestartResumeDecision =
  | { kind: 'none' }
  | { kind: 'pinned' }
  | {
      kind: 'selected'
      providerSession: AgentProviderSessionMetadata
      /** Puts the intent back for the next resume when this launch fails before commit. */
      unspend: () => void
    }

type RestartIntentState = 'pending' | 'ready' | 'withdrawn'

type RestartMark = {
  paneKey: string
  ptyId: string
  incarnationId: string
  provenance: CodexRestartProvenance
  opIds: Set<string>
  delivered: boolean
  writerProof: boolean
  withdrawn: boolean
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

function isValidRequest(
  r: Partial<CodexAccountRestartStopRequest> | null | undefined
): r is CodexAccountRestartStopRequest {
  return Boolean(
    r &&
    typeof r.worktreeId === 'string' &&
    r.worktreeId &&
    typeof r.tabId === 'string' &&
    r.tabId &&
    typeof r.leafId === 'string' &&
    r.leafId &&
    typeof r.ptyId === 'string' &&
    r.ptyId &&
    typeof r.opId === 'string' &&
    r.opId
  )
}

function sameOccupant(a: CodexRestartOccupant, b: CodexRestartOccupant): boolean {
  return (
    a.ptyId === b.ptyId &&
    a.incarnationId === b.incarnationId &&
    a.provenance.threadId === b.provenance.threadId &&
    a.provenance.transcriptPath === b.provenance.transcriptPath
  )
}

/** Main's one register of account-restart stops: admission, exit classification and the resume gate. */
export class CodexAccountRestartStops {
  private readonly inFlightByPane = new Map<string, InFlightStop>()
  private readonly markByIncarnation = new Map<string, RestartMark>()
  private readonly markByPane = new Map<string, RestartMark>()
  private readonly retiredIncarnations = new Set<string>()

  /** Admits one stop per pane; a second request for the same pane joins the stop in flight. */
  request(
    request: CodexAccountRestartStopRequest,
    deps: CodexAccountRestartStopDeps
  ): Promise<CodexAccountRestartStopResult> {
    if (!isValidRequest(request)) {
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
    let settle!: () => void
    const mark: RestartMark = {
      paneKey,
      ptyId: occupant.ptyId,
      incarnationId: occupant.incarnationId,
      provenance: occupant.provenance,
      opIds: new Set([request.opId]),
      delivered: false,
      writerProof: false,
      withdrawn: false,
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
    const mark = this.markByPane.get(codexAccountRestartPaneKey(request))
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
    if (observation === 'fenced-ended') {
      // A receipt may advance proof after the stream exit was already delivered.
      mark.writerProof = true
    }
    if (mark.delivered) {
      return 'duplicate'
    }
    mark.delivered = true
    return 'restart'
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

  /** Close or rebind of the pane: its intent no longer applies. */
  forgetPane(paneKey: string): void {
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
    return {
      kind: 'selected',
      providerSession: {
        ...providerSession,
        transcriptPath: mark.provenance.transcriptPath
      },
      unspend: () => {
        if (!this.markByPane.has(mark.paneKey)) {
          this.retiredIncarnations.delete(mark.incarnationId)
          this.installMark(mark)
        }
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
    const recheck = deps.resolveOccupant(request)
    if (mark.withdrawn || typeof recheck === 'string' || !sameOccupant(recheck, occupant)) {
      // A stale choice at the authorization boundary sends zero stop requests.
      this.retireMark(mark)
      const reason = mark.withdrawn
        ? 'withdrawn'
        : typeof recheck === 'string'
          ? recheck
          : 'superseded'
      return { outcome: 'not-started', reason, opIds: [...mark.opIds] }
    }
    let outcome: CodexRestartStopOutcome
    try {
      outcome = await deps.stop(occupant)
    } catch {
      outcome = 'unknown'
    }
    const opIds = [...mark.opIds]
    if ((outcome === 'refused' || outcome === 'unsupported') && !mark.delivered) {
      this.retireMark(mark)
      // `unsupported` lets the renderer fall back to the replacement restart.
      return { outcome: 'not-started', reason: outcome, opIds }
    }
    if (outcome === 'ended') {
      mark.writerProof = true
    }
    // Host loss and ambiguous attempts are never proof: the resume stays on the pinned account.
    mark.state = mark.writerProof && !mark.withdrawn ? 'ready' : 'withdrawn'
    return mark.writerProof ? { outcome: 'stopped', opIds } : { outcome: 'unknown', opIds }
  }

  private installMark(mark: RestartMark): void {
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
    if (!mark.delivered) {
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
