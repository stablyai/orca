import {
  reusePromptProjection,
  type PromptProjection
} from './structured-agent-session-actionable-prompts'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { isHistoricalProviderTimelineItem } from '../agent-session-timeline/provider-timeline-history'
import { currentRequestsProjection } from './agent-session-current-requests'
// Derive operational work from lease, first-hand exit, replaced-runtime and journal evidence.
// Cleanup writes never gate current work; readers share this projection rather than maintaining rules.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalSubmission,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionLatestTurn } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionWorkScope } from '../../../shared/structured-agent-session-main-agent-working'
import { isUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-unanswered-dispatch'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

export type StructuredAgentSessionCurrentWorkJournal = Pick<
  AgentSessionJournal,
  'runningTurn' | 'itemFence' | 'visitItems' | 'submissions' | 'wroteBeforeOpen' | 'item' | 'cursor'
> &
  Partial<Pick<AgentSessionJournal, 'readSince'>>

export type StructuredAgentSessionWorkEvidence = {
  record: Pick<AgentSessionConversationView, 'ownerObservation' | 'currentFence'> | null
  ended?: StructuredAgentSessionSeenEnd
  revision?: number
  replaced?: StructuredAgentSessionReplacedEnd | undefined
  /** Absent means the host has no child observation. */
  child?: { fence: number; heldSends?: () => ReadonlySet<string> | undefined } | null
}

/** Replaced runtimes granted all fences through this boundary. */
type StructuredAgentSessionReplacedEnd = { fence: number }

type StructuredAgentSessionSeenEnd = {
  fence: number
  rootGone?: boolean
  cause?: string
}

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

const promptProjections = new WeakMap<StructuredAgentSessionCurrentWorkJournal, PromptProjection>()

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

  /** Compare effective generation/view, not repeated end-signal revisions that may change nothing. */
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

  /** Unanswered sends the child no longer holds read uncertain until their later echo/refusal. */
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
    return this.journal.submissions().filter((submission) => this.unanswered(submission))
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

  /** Hand over only this process’s accepted sends; earlier-process sends recover as cards first. */
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
    const cursor = this.journal.cursor()
    const prior = promptProjections.get(this.journal)
    const reusable = reusePromptProjection(this.journal, prior, cursor, this.liveFence)
    if (reusable) {
      return reusable
    }
    const dependencies = new Set<string>()
    const items: AgentJournalRenderItem[] = []
    this.journal.visitItems((itemId, _sequence, body) => {
      if (
        (body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'pending'
      ) {
        const item = this.journal.item(itemId)
        dependencies.add(itemId)
        if (item?.turnScope?.kind === 'turn') {
          dependencies.add(item.turnScope.turnItemId)
          const turn = readAgentJournalTurn(this.journal.item(item.turnScope.turnItemId)?.body)
          if (turn?.userItemId) {
            dependencies.add(turn.userItemId)
          }
        }
        if (item && this.isCurrentItem(itemId)) {
          items.push(item)
        }
      }
    })
    items.sort(compareAgentJournalItems)
    const stable =
      prior?.items.length === items.length &&
      items.every((item, index) => item === prior.items[index])
        ? prior.items
        : items
    promptProjections.set(this.journal, {
      ...cursor,
      fence: this.liveFence,
      items: stable,
      dependencies
    })
    return stable
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
    return this.journal.submissions().some((submission) => this.owesSend(submission))
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
