import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session/agent-session-wire'
import type { JournalObserverResult } from '../../agent-session-journal/journal-observer-read'
import type { JournalSqlWorkResult } from '../../agent-session-journal/journal-work-read'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { currentRequestsProjection } from './agent-session-current-requests'

type WorkState = JournalObserverResult['work']
const presentations = new WeakMap<
  WorkState,
  { submissions: ReadonlyMap<string, AgentJournalSubmission>; promptIds: string[] }
>()

/** Finished observer answers; selection and live-work policy remain in the reader snapshot. */
export class StructuredAgentSessionObservedWork {
  private readonly presentation: NonNullable<ReturnType<typeof presentations.get>>

  constructor(
    private readonly journal: Pick<SqlAgentSessionJournal, 'cursor'>,
    private readonly work: WorkState,
    readonly cursor: AgentJournalCursor,
    readonly readSource?: JournalSqlWorkResult
  ) {
    let presentation = presentations.get(work)
    if (!presentation) {
      presentation = {
        submissions: new Map(work.restatedSubmissions.map((send) => [send.clientMessageId, send])),
        promptIds: work.actionablePrompts.map((item) => item.itemId)
      }
      presentations.set(work, presentation)
    }
    this.presentation = presentation
  }

  get liveFence() {
    return this.work.liveFence
  }
  allowsObservation = () => this.work.allowsObservation
  queueState = () => this.work
  working = () => this.work.working
  owesAnySend = () => this.work.owesAnySend
  activeTurn = () => this.work.activeTurn
  activeTurnId = () => this.work.activeTurn?.turnId ?? null
  /** The message that opened the running turn; null when none runs. */
  activeTurnOpener = () => this.work.activeTurnOpener ?? null
  turnScope = (): AgentJournalTurnScope =>
    this.work.activeTurn
      ? { kind: 'turn', turnItemId: this.work.activeTurn.item.itemId }
      : AGENT_JOURNAL_THREAD_SCOPE
  actionablePrompts = () => this.work.actionablePrompts
  actionablePromptIds = () => this.presentation.promptIds
  hasActionablePrompt = () => this.work.actionablePrompts.length > 0
  publishedLatestTurn = (_latest: AgentSessionLatestTurn | null) => this.work.latestTurn
  // Work can outlive receipts. A page owns the attempt and its receipt metadata.
  publishedSubmission = (submission: AgentJournalSubmission): AgentJournalSubmission => {
    const presentation = this.presentation.submissions.get(submission.clientMessageId)
    if (
      !presentation ||
      presentation.fence !== submission.fence ||
      presentation.handedOverAt !== submission.handedOverAt
    ) {
      return submission
    }
    const { dispatchState, reason, recovered } = presentation
    return {
      ...submission,
      dispatchState,
      reason,
      ...(recovered === undefined ? {} : { recovered })
    }
  }
  restatedSubmissions = () => this.work.restatedSubmissions
  viewKey = () => this.work.viewKey
  workViewKey = () => this.work.workViewKey
  requestProjection = (sessionId: string) =>
    currentRequestsProjection(this.journal, sessionId, this, this.cursor)
}
