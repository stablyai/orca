import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import type {
  StructuredAgentSessionWorkEvidence,
  StructuredAgentSessionCurrentWorkJournal,
  StructuredAgentSessionSeenEnd,
  StructuredAgentSessionReplacedEnd
} from './structured-agent-session-work-evidence'
import { prepareActionablePromptSteps } from './structured-agent-session-actionable-prompts'

import { isHistoricalProviderTimelineItem } from '../agent-session-timeline/provider-timeline-history'
import { currentRequestsProjection } from './agent-session-current-requests'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionLatestTurn } from '../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { isUnansweredStructuredAgentSessionDispatch } from '../../../shared/agent-session/requests/structured-agent-session-unanswered-dispatch'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'
export type { StructuredAgentSessionWorkEvidence } from './structured-agent-session-work-evidence'
// Derive operational work from lease, first-hand exit, replaced-runtime and journal evidence.
// Cleanup writes never gate current work; readers share this projection rather than maintaining rules.

export type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-work-evidence'

/** Missing records retain legacy fence-0 behavior; released/ended generations have no live fence. */
export function structuredAgentSessionLiveFence(
  evidence: StructuredAgentSessionWorkEvidence
): number | null {
  const record = evidence.record
  const lease = record?.ownerObservation
  const fence = record?.currentFence
  if (!lease) {
    return 0
  }
  if (lease.claimStatus === 'released') {
    return null
  }
  if (
    structuredAgentSessionReplacedRuntimeEnded(
      { runtimeFence: fence ?? 0, claimStatus: lease.claimStatus },
      evidence.replaced
    ) ||
    structuredAgentSessionOwnerUnverifiable(evidence)
  ) {
    return null
  }
  const { ended } = evidence
  return ended?.rootGone === true && ended.fence === fence ? null : (fence ?? 0)
}

/** Unreconciled/recovering owners without a local child remain unverifiable, not current work. */
function structuredAgentSessionOwnerUnverifiable(evidence: StructuredAgentSessionWorkEvidence) {
  const record = evidence.record
  const lease = record?.ownerObservation
  const fence = record?.currentFence
  return (
    (lease?.unreconciled === true || lease?.handoffStage === 'recovering') &&
    evidence.child !== undefined &&
    evidence.child?.fence !== fence
  )
}

/** Replaced runtimes lost their pipes; conflicted terminal claims are outside that proof. */
export function structuredAgentSessionReplacedRuntimeEnded(
  lease: Pick<AgentSessionRecord['lease'], 'runtimeFence' | 'claimStatus'>,
  replaced: StructuredAgentSessionReplacedEnd | undefined
): boolean {
  return (
    replaced !== undefined &&
    lease.runtimeFence <= replaced.fence &&
    lease.claimStatus !== 'conflicted'
  )
}

function structuredAgentSessionHandsOver(
  journal: Pick<AgentSessionJournal, 'wroteBeforeOpen'>,
  submission: Pick<
    AgentJournalSubmission,
    'handoverRecorded' | 'dispatchState' | 'handedOverAt' | 'acceptedSequence'
  >
): boolean {
  return (
    isQueuedAgentJournalSubmission(submission) &&
    !journal.wroteBeforeOpen(submission.acceptedSequence)
  )
}

/** Re-read lease evidence per decision; immutable prompts share cursor/fence caches. */
export class StructuredAgentSessionCurrentWork {
  readonly scope: StructuredAgentSessionWorkScope = {
    isCurrentItem: (itemId) => this.isCurrentItem(itemId),
    owesSend: (submission) => this.owesSend(submission)
  }

  constructor(
    private readonly journal: StructuredAgentSessionCurrentWorkJournal,
    readonly liveFence: number | null,
    /** Invalidate cached work with journal cursor and observed generation-end revision, even if lease writes fail. */
    readonly revision = 0,
    private readonly ended?: StructuredAgentSessionSeenEnd,
    private readonly replaced?: StructuredAgentSessionReplacedEnd,
    private readonly ownerUnverifiable = false,
    /** Missing child evidence conservatively holds every unanswered send. */
    private readonly heldSends?: () => ReadonlySet<string> | undefined
  ) {}

  allowsObservation(): boolean {
    return !this.ownerUnverifiable
  }

  generationEnded(submission: AgentJournalSubmission): boolean {
    if (this.ownerUnverifiable) {
      return false
    }
    const fence = submission.fence
    return (
      (this.liveFence !== null && fence < this.liveFence) ||
      this.liveFence === null ||
      (this.replaced !== undefined && fence <= this.replaced.fence) ||
      (this.ended?.rootGone === true && fence === this.ended.fence)
    )
  }

  /** What a reader that published this answer compares to learn it changed with no row: the live
   *  generation, since every answer here is the journal read through it. Not the revision, which
   *  moves on every generation-end signal: an end that changed nothing is published once. */
  viewKey(): string {
    return `${this.liveFence}${this.ownerUnverifiable ? ':unverifiable' : ''}`
  }

  /** Include held sends/working state; viewKey separately identifies published request markers. */
  workViewKey(): string {
    const sends = this.unansweredSends().map(
      (submission) => `${submission.clientMessageId}:${this.holds(submission) ? 1 : 0}`
    )
    return `${this.viewKey()}|${this.working() ? 1 : 0}|${sends.join(',')}`
  }

  /** A send as clients are told it. One handed to the live child that it no longer holds, with no
   *  answer, reads in doubt: no client counts it as work, and its echo or refusal still settles it. */
  publishedSubmission = (submission: AgentJournalSubmission): AgentJournalSubmission =>
    this.unanswered(submission) && !this.holds(submission)
      ? {
          ...submission,
          dispatchState: 'unknown',
          recovered: true,
          reason: submission.reason ?? DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED
        }
      : submission

  private unanswered(submission: AgentJournalSubmission): boolean {
    return (
      continuingStructuredAgentSessionInput(this.journal, submission.clientMessageId) ||
      (submission.dispatchState === 'pending' &&
        finalizingStructuredAgentSessionInput(this.journal, submission.clientMessageId)) ||
      (!isQueuedAgentJournalSubmission(submission) &&
        this.liveFence !== null &&
        isUnansweredStructuredAgentSessionDispatch(submission, this.liveFence))
    )
  }

  private unansweredSends(): AgentJournalSubmission[] {
    return this.journal.inputOrder
      .recoverableSubmissions()
      .filter((submission) => this.unanswered(submission))
  }

  /** Restate held-send changes even without journal rows. */
  restatedSubmissions(): AgentJournalSubmission[] {
    return this.unansweredSends().map(this.publishedSubmission)
  }

  private holds(submission: AgentJournalSubmission): boolean {
    const held = this.heldSends?.()
    return (
      held === undefined ||
      held.has(submission.clientMessageId) ||
      structuredAgentSessionHandingOver(this.journal).has(submission.clientMessageId)
    )
  }

  isCurrentItem(itemId: string): boolean {
    if (this.liveFence === null) {
      return false
    }
    const item = this.journal.item(itemId)
    if (item && isHistoricalProviderTimelineItem(item, (key) => this.journal.item(key))) {
      return false
    }
    const provenance = this.journal.itemFence(itemId)
    return provenance === undefined || provenance >= this.liveFence
  }

  /** Hand over only this process’s accepted sends; earlier-process sends remain ordinary history. */
  handsOver(submission: AgentJournalSubmission): boolean {
    return structuredAgentSessionHandsOver(this.journal, submission)
  }

  /** Work means admissible queued sends or unanswered sends the live child still holds, never stale delivery rows. */
  owesSend(submission: AgentJournalSubmission): boolean {
    if (isQueuedAgentJournalSubmission(submission)) {
      return this.handsOver(submission)
    }
    return this.unanswered(submission) && this.holds(submission)
  }

  activeTurn(): { item: AgentJournalRenderItem; turnId: string } | null {
    const running = this.journal.runningTurn()
    return running && this.isCurrentItem(running.item.itemId) ? running : null
  }

  activeTurnId(): string | null {
    return this.activeTurn()?.turnId ?? null
  }

  turnScope(): AgentJournalTurnScope {
    const running = this.activeTurn()
    return running ? { kind: 'turn', turnItemId: running.item.itemId } : AGENT_JOURNAL_THREAD_SCOPE
  }

  actionablePrompts(): AgentJournalRenderItem[] {
    return finishJournalSteps(this.actionablePromptSteps())
  }
  actionablePromptSteps(current?: () => boolean): Generator<void, AgentJournalRenderItem[]> {
    return prepareActionablePromptSteps(this.journal, this, current)
  }

  requestProjection(sessionId: string) {
    return currentRequestsProjection(this.journal, sessionId, this)
  }

  actionablePromptIds(): string[] {
    return this.actionablePrompts().map((item) => item.itemId)
  }

  hasActionablePrompt(): boolean {
    return this.actionablePromptIds().length > 0
  }

  owesAnySend(): boolean {
    return this.journal.inputOrder
      .recoverableSubmissions()
      .some((submission) => this.owesSend(submission))
  }

  working(): boolean {
    return this.activeTurnId() !== null || this.owesAnySend()
  }

  /** Project interrupted turns immediately from observed/replaced-runtime death, before settlement persists. */
  diedTurn(): { item: AgentJournalRenderItem; turnId: string } | null {
    const running = this.journal.runningTurn()
    if (!running || this.isCurrentItem(running.item.itemId)) {
      return null
    }
    const fence = this.journal.itemFence(running.item.itemId)
    const { ended, replaced } = this
    const died = ended?.rootGone === true && ended.cause === 'exit' && fence === ended.fence
    return died || (replaced !== undefined && fence !== undefined && fence <= replaced.fence)
      ? running
      : null
  }

  /** Hide ended-generation work; publish interruption or owner uncertainty without implying completion. */
  publishedLatestTurn(latest: AgentSessionLatestTurn | null): AgentSessionLatestTurn | null {
    if (latest?.turn.state !== 'running' || this.isCurrentItem(latest.itemId)) {
      return latest
    }
    if (this.diedTurn()?.item.itemId === latest.itemId) {
      return { ...latest, turn: { ...latest.turn, state: 'interrupted' } }
    }
    return this.ownerUnverifiable
      ? { ...latest, turn: { ...latest.turn, state: 'unverifiable' } }
      : null
  }
}

export function structuredAgentSessionCurrentWork(
  journal: StructuredAgentSessionCurrentWorkJournal,
  evidence: StructuredAgentSessionWorkEvidence
): StructuredAgentSessionCurrentWork {
  return new StructuredAgentSessionCurrentWork(
    journal,
    structuredAgentSessionLiveFence(evidence),
    evidence.revision,
    evidence.ended,
    evidence.replaced,
    structuredAgentSessionOwnerUnverifiable(evidence),
    evidence.child?.heldSends
  )
}

/** Test contexts without host projections treat their fence as live. */
export function contextStructuredAgentSessionCurrentWork(ctx: {
  journal: StructuredAgentSessionCurrentWorkJournal
  fence: number
  currentWork?: () => StructuredAgentSessionCurrentWork | null
}): StructuredAgentSessionCurrentWork {
  return ctx.currentWork?.() ?? new StructuredAgentSessionCurrentWork(ctx.journal, ctx.fence)
}
