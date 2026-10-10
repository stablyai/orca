// The host's one operational projection of a chat's current work: the live generation's running
// turn, the prompts it raised that still wait on the person, the sends it owes, and the queued
// sends this process may hand over. Every host reader asks here; none keeps a rule of its own.
//
// Derived on every read, never stored, from what the host already holds:
//  - the lease: the live or reserved generation's fence; none once it is released;
//  - this host's own sight of that generation's root exit, which ends it even when the release
//    write failed (`lastEndedChild`);
//  - the Orca runtimes this one replaced (`AgentSessionRecordStore.replacedRuntime`): a generation
//    one of them held lost its pipes with it, so it is over before any startup write says so;
//  - the journal's fold, where every item carries the generation that produced it (`ownerFence`).
// So work an ended generation left holds nothing and is not Working whether or not its cleanup
// landed: cleanup is bookkeeping and never gates what the person does next. Loss of contact is
// never an end: an unreconciled or conflicted lease keeps its fence, and its work stays current, unless
// a runtime this one replaced held it, which is this host's own proof.

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

export type StructuredAgentSessionCurrentWorkJournal = Pick<
  AgentSessionJournal,
  'runningTurn' | 'itemFence' | 'visitItems' | 'submissions' | 'wroteBeforeOpen'
>

/** What the host knows of who runs the chat now. */
export type StructuredAgentSessionWorkEvidence = {
  record: Pick<AgentSessionRecord, 'lease'> | null
  /** The last child this host saw end (`StructuredAgentSessionHostSession.lastEndedChild`). */
  ended?: StructuredAgentSessionSeenEnd
  /** `StructuredAgentSessionHostSession.operationalRevision`. */
  revision?: number
  /** The runtimes this one replaced for the chat (`AgentSessionRecordStore.replacedRuntime`). */
  replaced?: StructuredAgentSessionReplacedEnd | undefined
  /** This host's live child (`StructuredAgentSessionHostSession.child`); absent: not known. */
  child?: { fence: number } | null
}

/** Every fence at or below `fence` was granted by a runtime this one replaced. */
type StructuredAgentSessionReplacedEnd = { fence: number }

type StructuredAgentSessionSeenEnd = { fence: number; rootGone?: boolean; cause?: string }

/** The live or reserved generation's fence, or null when no generation is live. With no record
 *  nothing has ended: fence 0, under which every item is current, as before records scoped work. */
export function structuredAgentSessionLiveFence(
  evidence: StructuredAgentSessionWorkEvidence
): number | null {
  const lease = evidence.record?.lease
  if (!lease) {
    return 0
  }
  if (lease.claimStatus === 'released') {
    return null
  }
  if (
    structuredAgentSessionReplacedRuntimeEnded(lease, evidence.replaced) ||
    structuredAgentSessionOwnerUnverifiable(evidence)
  ) {
    return null
  }
  const { ended } = evidence
  return ended?.rootGone === true && ended.fence === lease.runtimeFence ? null : lease.runtimeFence
}

/** An owner not yet reconciled, or latched in recovery, that this process holds no child for: it
 *  may still be running, so its turn is unverifiable, and nothing it left is current work. */
function structuredAgentSessionOwnerUnverifiable(evidence: StructuredAgentSessionWorkEvidence) {
  const lease = evidence.record?.lease
  return (
    (lease?.unreconciled === true || lease?.handoffStage === 'recovering') &&
    evidence.child !== undefined &&
    evidence.child?.fence !== lease.runtimeFence
  )
}

/** Whether a runtime this one replaced granted the lease's generation, which is then over. A
 *  conflicted claim's agent is a terminal's, which no runtime's pipes held. */
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

/** `StructuredAgentSessionCurrentWork.handsOver`, for a reader that needs no other answer. */
export function structuredAgentSessionHandsOver(
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

/** One read of a chat's current work; build a fresh one per decision, since nothing is cached. */
export class StructuredAgentSessionCurrentWork {
  /** The shared projections' form of this answer (`StructuredAgentSessionWorkScope`). */
  readonly scope: StructuredAgentSessionWorkScope = {
    isCurrentItem: (itemId) => this.isCurrentItem(itemId),
    owesSend: (submission) => this.owesSend(submission)
  }

  constructor(
    private readonly journal: StructuredAgentSessionCurrentWorkJournal,
    /** `structuredAgentSessionLiveFence`. */
    readonly liveFence: number | null,
    /** Moves with every generation end this host saw, lease write or not: a reader that caches
     *  what it derived from this answer keys it here and on the journal's cursor. */
    readonly revision = 0,
    private readonly ended?: StructuredAgentSessionSeenEnd,
    private readonly replaced?: StructuredAgentSessionReplacedEnd,
    /** `structuredAgentSessionOwnerUnverifiable`. */
    private readonly ownerUnverifiable = false
  ) {}

  /** What a reader that published this answer compares to learn it changed with no row: the live
   *  generation, since every answer here is the journal read through it. Not the revision, which
   *  moves on every generation-end signal: an end that changed nothing is published once. */
  viewKey(): string {
    return `${this.liveFence}${this.ownerUnverifiable ? ':unverifiable' : ''}`
  }

  /** Whether the live generation's execution produced this item. */
  isCurrentItem(itemId: string): boolean {
    if (this.liveFence === null) {
      return false
    }
    const provenance = this.journal.itemFence(itemId)
    return provenance === undefined || provenance >= this.liveFence
  }

  /** Whether this process may hand this send over: accepted here, never by an earlier host process.
   *  Derived from where the row sits, so nothing has to be written first; keeping an earlier
   *  process's send as a card is the reconciliation pass's bookkeeping (`holdUnsentSends`). */
  handsOver(submission: AgentJournalSubmission): boolean {
    return structuredAgentSessionHandsOver(this.journal, submission)
  }

  /** A send still owed: one this process may hand over, or one handed to the live generation that
   *  it has neither answered nor refused (`isUnansweredStructuredAgentSessionDispatch`). */
  owesSend(submission: AgentJournalSubmission): boolean {
    if (isQueuedAgentJournalSubmission(submission)) {
      return this.handsOver(submission)
    }
    return (
      this.liveFence !== null &&
      isUnansweredStructuredAgentSessionDispatch(submission, this.liveFence)
    )
  }

  /** The live generation's running turn, with its record's item. */
  activeTurn(): { item: AgentJournalRenderItem; turnId: string } | null {
    const running = this.journal.runningTurn()
    return running && this.isCurrentItem(running.item.itemId) ? running : null
  }

  activeTurnId(): string | null {
    return this.activeTurn()?.turnId ?? null
  }

  /** Where a row written now joins: the live generation's running turn, else the conversation. */
  turnScope(): AgentJournalTurnScope {
    const running = this.activeTurn()
    return running ? { kind: 'turn', turnItemId: running.item.itemId } : AGENT_JOURNAL_THREAD_SCOPE
  }

  /** The approvals and questions the live generation raised that wait on the person, a
   *  subagent's included. */
  actionablePromptIds(): string[] {
    const ids: string[] = []
    this.journal.visitItems((itemId, _sequence, body) => {
      if (
        (body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'pending' &&
        this.isCurrentItem(itemId)
      ) {
        ids.push(itemId)
      }
    })
    return ids
  }

  hasActionablePrompt(): boolean {
    return this.actionablePromptIds().length > 0
  }

  owesAnySend(): boolean {
    return this.journal.submissions().some((submission) => this.owesSend(submission))
  }

  /** The session's own agent is working: its running turn, or a send it owes. */
  working(): boolean {
    return this.activeTurnId() !== null || this.owesAnySend()
  }

  /** The running turn of a generation this host saw die on its own (its root gone, nobody asked),
   *  or that a runtime this one replaced held: its settlement writes it interrupted, so it reads so
   *  before that lands. */
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

  /** The newest turn record as a client is told it: a running one an ended generation opened is
   *  none, interrupted when it died on its own (`diedTurn`), or unverifiable while its owner is, so
   *  no client reads it as working, steers into it or reads it finished. */
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
    structuredAgentSessionOwnerUnverifiable(evidence)
  )
}

/** An operation context's current work: the host projection it was built with, or, for one built
 *  without (a test's), the generation at its fence read as live. */
export function contextStructuredAgentSessionCurrentWork(ctx: {
  journal: StructuredAgentSessionCurrentWorkJournal
  fence: number
  currentWork?: () => StructuredAgentSessionCurrentWork | null
}): StructuredAgentSessionCurrentWork {
  return ctx.currentWork?.() ?? new StructuredAgentSessionCurrentWork(ctx.journal, ctx.fence)
}
