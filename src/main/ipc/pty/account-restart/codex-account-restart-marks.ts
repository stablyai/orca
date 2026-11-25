import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CodexAccountRestartStopRequest } from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'
import type {
  CodexRestartExitClassification,
  CodexRestartExitObservation,
  CodexRestartProvenance,
  CodexRestartResumeDecision
} from './codex-account-restart-types'

export type RestartIntentState = 'pending' | 'ready' | 'withdrawn'

export type RestartMark = {
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

// Bounded by panes, not time: enough to reject late exits after the mark is spent or replaced.
const RETIRED_INCARNATION_LIMIT = 256

export function codexAccountRestartPaneKey(
  request: Pick<CodexAccountRestartStopRequest, 'worktreeId' | 'tabId' | 'leafId'>
): string {
  return `${request.worktreeId}\0${request.tabId}\0${request.leafId}`
}

/** The register of restart marks: which exits are restart exits, who still needs them, and the resume decision. */
export class CodexAccountRestartMarks {
  protected readonly markByIncarnation = new Map<string, RestartMark>()
  protected readonly markByPane = new Map<string, RestartMark>()
  // A granted intent stays reachable until its launch starts, so Dismiss still applies to it.
  protected readonly spentMarkByPane = new Map<string, RestartMark>()
  // Panes whose stopped conversation came back missing, with the operations of the stop that did it;
  // bounded by panes.
  protected readonly refusedPanes = new Map<string, ReadonlySet<string>>()
  protected readonly retiredIncarnations = new Set<string>()
  // Restart exits sent while no ready window existed; the next window that signals ready gets them.
  protected readonly rendererOwed = new Set<RestartMark>()

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
    if (rendererOwed) {
      this.rendererOwed.delete(mark)
    }
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
  /** The exit just sent for this incarnation reached no ready window; owe it to the next one. */
  noteRendererUndelivered(ptyId: string, incarnationId: string | null | undefined): void {
    const mark = incarnationId ? this.markByIncarnation.get(incarnationId) : undefined
    if (mark && mark.ptyId === ptyId) {
      mark.rendererDelivered = false
      this.rendererOwed.add(mark)
    }
  }
  /** Restart exits a newly ready window still needs; each is handed out once. */
  takeOwedRendererExits(): { ptyId: string; incarnationId: string }[] {
    const owed = [...this.rendererOwed].map((mark) => {
      mark.rendererDelivered = true
      return { ptyId: mark.ptyId, incarnationId: mark.incarnationId }
    })
    this.rendererOwed.clear()
    return owed
  }
  /** A proven restart whose pane comes back without its conversation must fail once, not open a shell. */
  async refusesResumeWithoutConversation(paneKey: string): Promise<boolean> {
    // Automatic remounts keep failing until the user dismisses the failure or closes the pane.
    if (this.refusedPanes.has(paneKey)) {
      return true
    }
    const mark = this.markByPane.get(paneKey)
    if (!mark || mark.withdrawn) {
      return false
    }
    await mark.settled
    if (this.markByPane.get(paneKey) !== mark || mark.state !== 'ready') {
      return false
    }
    this.retireMark(mark)
    this.refusedPanes.set(paneKey, new Set(mark.opIds))
    return true
  }

  /** The user dismissed this failure: the pane's next start is ordinary. A Dismiss naming another
   *  stop's operations (a late one, from an earlier refusal) leaves a newer refusal standing. */
  releaseRefusedPane(paneKey: string, opIds: readonly string[]): boolean {
    const refusedBy = this.refusedPanes.get(paneKey)
    if (!refusedBy || !opIds.some((opId) => refusedBy.has(opId))) {
      return false
    }
    this.refusedPanes.delete(paneKey)
    return true
  }
  /** Close or rebind of the pane: its intent no longer applies. */
  forgetPane(paneKey: string): void {
    this.spentMarkByPane.delete(paneKey)
    this.refusedPanes.delete(paneKey)
    for (const owed of this.rendererOwed) {
      if (owed.paneKey === paneKey) {
        this.rendererOwed.delete(owed)
      }
    }
    const mark = this.markByPane.get(paneKey)
    if (mark) {
      this.retireMark(mark)
    }
  }
  protected grantSelectedAccountResume(
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
  protected installMark(mark: RestartMark): void {
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
  protected retireMark(mark: RestartMark): void {
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

export function isDelivered(mark: RestartMark): boolean {
  return mark.runtimeDelivered || mark.rendererDelivered
}
