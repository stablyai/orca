import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session/agent-session-wire'
import type { JournalObserverResult } from '../../agent-session-journal/journal-observer-read'
import type { JournalSqlWorkResult } from '../../agent-session-journal/journal-work-read'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { currentRequestsProjection } from './agent-session-current-requests'
import { journalDispatchRowApplies } from '../../agent-session-journal/projection/journal-dispatch-settlement'

/** Finished observer answers; selection and live-work policy remain in the reader snapshot. */
export class StructuredAgentSessionObservedWork {
  private readonly restated: ReadonlyMap<string, AgentJournalSubmission>

  constructor(
    private readonly journal: Pick<SqlAgentSessionJournal, 'cursor'>,
    private readonly work: JournalObserverResult['work'],
    readonly cursor: AgentJournalCursor,
    readonly readSource?: JournalSqlWorkResult
  ) {
    this.restated = new Map(work.restatedSubmissions.map((send) => [send.clientMessageId, send]))
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
  turnScope = (): AgentJournalTurnScope =>
    this.work.activeTurn
      ? { kind: 'turn', turnItemId: this.work.activeTurn.item.itemId }
      : AGENT_JOURNAL_THREAD_SCOPE
  actionablePrompts = () => this.work.actionablePrompts
  actionablePromptIds = () => this.work.actionablePrompts.map((item) => item.itemId)
  hasActionablePrompt = () => this.work.actionablePrompts.length > 0
  publishedLatestTurn = (_latest: AgentSessionLatestTurn | null) => this.work.latestTurn
  // Restatements cover sends this read saw unanswered; a page row already settled is newer than it.
  publishedSubmission = (submission: AgentJournalSubmission) =>
    (journalDispatchRowApplies(submission) && this.restated.get(submission.clientMessageId)) ||
    submission
  restatedSubmissions = () => this.work.restatedSubmissions
  viewKey = () => this.work.viewKey
  workViewKey = () => this.work.workViewKey
  requestProjection = (sessionId: string) =>
    currentRequestsProjection(this.journal, sessionId, this, this.cursor)
}
