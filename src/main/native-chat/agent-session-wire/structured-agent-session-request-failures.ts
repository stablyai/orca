import type {
  Baseline,
  CompletionMark,
  AccountedRequest
} from './structured-agent-session-request-failure-observation'
import { observeRequestFailures } from './structured-agent-session-request-failure-observation'
import {
  requestFailureReader,
  forgetRequestFailureBaseline
} from './structured-agent-session-released-failure-read'
import { structuredAgentSessionProviderRetryCompletion } from './structured-agent-session-provider-retry'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import {
  isStructuredAgentSessionCommandTurn,
  isStructuredAgentSessionCommandEntry
} from '../../../shared/structured-agent-session-command-entry'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import type {
  ProviderRetryCompletion,
  ProviderRetryDisposition
} from './structured-agent-session-provider-retry'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { JournalAppliedSubmission } from '../agent-session-journal/journal-reducer'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'

export type StructuredAgentSessionRequestFailure = {
  sessionId: string
  agent: string
  kind: 'turn' | 'refused-send'
  id: string
  outcome: 'failure' | 'interruption'
  capturePendingOutput?: () => (() => boolean) | undefined
  death?: NonNullable<StructuredAgentSessionHostSession['lastEndedChild']> &
    AgentSessionFailureWordsContext
  read: () => Promise<AgentJournalSnapshot | null>
}

/** Live request edges use the journal's fold before the latest-only publications can coalesce. */
export class StructuredAgentSessionRequestFailures {
  private readonly baselines = new Map<string, Baseline>()

  constructor(
    private readonly deps: {
      sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
      onFailure: (failure: StructuredAgentSessionRequestFailure) => void
      capturePendingOutput?: StructuredAgentSessionAdapter['capturePendingOutput']
      wordsContext?: (sessionId: string) => AgentSessionFailureWordsContext
    }
  ) {}

  forget = (
    sessionId: string,
    disposition: 'abandon' | 'retire' = 'abandon'
  ): (() => void) | undefined =>
    forgetRequestFailureBaseline(this.baselines, sessionId, disposition)
  clear = (): void => {
    for (const id of this.baselines.keys()) {
      this.forget(id)
    }
  }

  observe: (
    sessionId: string,
    journal: AgentSessionJournal,
    rows?: readonly JournalRow[],
    applied?: readonly JournalAppliedSubmission[]
  ) => void = observeRequestFailures.bind(this)

  generationEnded = (sessionId: string): void => {
    const baseline = this.baselines.get(sessionId)
    const session = this.deps.sessions.get(sessionId)
    const ended = session?.lastEndedChild
    if (!baseline || !session || baseline.journal !== session.journal || baseline.ended === ended) {
      return
    }
    baseline.ended = ended
    const running = session.journal.runningTurn()
    if (running) {
      this.account(
        sessionId,
        baseline,
        this.request(baseline, 'turn', running.item.itemId, true),
        false
      )
    }
  }

  private request(
    baseline: Baseline,
    kind: StructuredAgentSessionRequestFailure['kind'],
    id: string,
    died = false
  ): AccountedRequest | null {
    const { journal } = baseline
    const item = journal.item(kind === 'turn' ? id : agentJournalSubmissionKey(id))
    if (!item || item.sequence <= baseline.floor || !isRootAgentJournalItem(item)) {
      return null
    }
    if (kind === 'refused-send') {
      const submission = journal.submission(id)
      if (
        !submission ||
        isStructuredAgentSessionCommandEntry(item.body) ||
        submission.answeredInTurn?.via === 'steer'
      ) {
        return null
      }
      const failed =
        submission.dispatchState === 'rejected' &&
        classifyDispatchRejection(submission).verdict === 'failure'
      const linked = submission.answeredInTurn?.turnItemId
      const turn =
        failed && linked ? this.request(baseline, 'turn', journal.canonicalItemId(linked)) : null
      return turn?.mark === 'failure' || turn?.mark === 'interruption'
        ? turn
        : {
            kind,
            id: item.itemId,
            mark: failed ? 'failure' : submission.dispatchState,
            edge: `${submission.dispatchState}:${submission.fence}:${submission.providerItemId ?? ''}`,
            created: submission.submittedSequence
          }
    }
    const turn = readAgentJournalTurn(item.body)
    if (!turn || isStructuredAgentSessionCommandTurn(turn, journal.itemBody)) {
      return null
    }
    const verdict = died
      ? 'interruption'
      : agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) })
    const ended = this.deps.sessions.get(baseline.sessionId)?.lastEndedChild
    const unexpected =
      ended?.rootGone === true &&
      ended.cause === 'exit' &&
      journal.itemFence(id) === ended.fence &&
      !journal.stopMarks.personStopDecides(turn.turnId, turn.completedAt)
    return {
      kind,
      id,
      mark: verdict === 'interruption' && !unexpected ? turn.state : (verdict ?? turn.state),
      edge: JSON.stringify([
        unexpected && verdict === 'interruption'
          ? ended?.endedAt.sequence
          : journal.turnEndedSequence(id),
        turn.turnId,
        turn.providerTurnId,
        journal.itemFence(id),
        unexpected && verdict === 'interruption' ? 'interrupted' : turn.state,
        unexpected && verdict === 'interruption'
          ? 'interruption'
          : readAgentJournalTurnOutcome(turn)
      ]),
      created: item.sequence
    }
  }

  private prune(baseline: Baseline, key: string): void {
    baseline.marks.delete(key)
    if (
      baseline.deferred &&
      `${baseline.deferred.request.kind}:${baseline.deferred.request.id}` === key
    ) {
      baseline.deferred = undefined
    }
  }

  private consume(baseline: Baseline, disposition: 'consumed' | 'historical'): void {
    const slot = baseline.deferred
    if (!slot) {
      return
    }
    const key = `${slot.request.kind}:${slot.request.id}`
    const mark = baseline.marks.get(key)
    if (mark?.edge === slot.request.edge) {
      mark.disposition = disposition
    }
    baseline.deferred = undefined
  }

  /** B hands off its exact completion before losing the execution identity, including row-free exits. */
  settleRecovery = (
    sessionId: string,
    journal: AgentSessionJournal,
    completion: ProviderRetryCompletion,
    disposition: ProviderRetryDisposition
  ): void => {
    const baseline = this.baselines.get(sessionId)
    if (
      !baseline ||
      baseline.releasedRead?.retiring ||
      baseline.journal !== journal ||
      baseline.epoch !== journal.epoch
    ) {
      return
    }
    if (disposition === 'abandon' || disposition === 'consume') {
      if (baseline.deferred?.owner === completion.owner) {
        this.consume(baseline, disposition === 'consume' ? 'consumed' : 'historical')
      }
      // A terminal may have committed in retry's observer before the accounting observer runs.
      const request = this.request(baseline, 'turn', completion.itemId)
      if (request && baseline.marks.get(`turn:${request.id}`)?.edge !== request.edge) {
        baseline.marks.set(`turn:${request.id}`, {
          edge: request.edge,
          created: request.created,
          disposition: disposition === 'consume' ? 'consumed' : 'historical'
        })
      }
      return
    }
    // Retry observes a committed terminal before normal accounting in this same tick.
    this.account(
      sessionId,
      baseline,
      this.request(baseline, 'turn', completion.itemId),
      false,
      false,
      true
    )
    const slot = baseline.deferred
    if (!slot || slot.owner !== completion.owner) {
      return
    }
    baseline.deferred = undefined
    const final = this.request(baseline, slot.request.kind, slot.request.id)
    if (final) {
      this.account(sessionId, baseline, final, false, true, true)
    }
  }

  private account(
    sessionId: string,
    baseline: Baseline,
    request: AccountedRequest | null,
    historical: boolean,
    release = false,
    releasedReport = false
  ): void {
    if (!request) {
      return
    }
    const key = `${request.kind}:${request.id}`
    const previous = baseline.marks.get(key)
    const incarnation = previous?.created === request.created
    if (request.kind === 'turn' && previous && !incarnation) {
      historical = true
    }
    const same = incarnation && previous?.edge === request.edge
    if (same && !(release && previous.disposition === 'deferred')) {
      return
    }
    if (baseline.deferred?.request.id === request.id && !same) {
      baseline.deferred = undefined
    }
    const outcome = request.mark
    const mark: CompletionMark = {
      edge: request.edge,
      created: request.created,
      disposition: historical ? 'historical' : 'observed'
    }
    baseline.marks.set(key, mark)
    if (historical || (outcome !== 'failure' && outcome !== 'interruption')) {
      return
    }
    const recovery = !release && structuredAgentSessionProviderRetryCompletion(baseline.journal)
    if (outcome === 'failure' && recovery && recovery.itemId === request.id) {
      this.consume(baseline, 'consumed')
      mark.disposition = 'deferred'
      baseline.deferred = { owner: recovery.owner, request }
      return
    }
    mark.disposition = 'reported'
    const { journal } = baseline
    const session = this.deps.sessions.get(sessionId)
    const child = session?.child
    const fence = journal.itemFence(request.id)
    const opener = journal.canonicalItemId(
      (request.kind === 'turn'
        ? readAgentJournalTurn(journal.itemBody(request.id) ?? undefined)?.userItemId
        : request.id) ?? ''
    )
    const { clientMessageId } =
      journal
        .submissions()
        .find(({ clientMessageId: id }) => agentJournalSubmissionKey(id) === opener) ?? {}
    const generation = child?.fence === fence ? child?.generation : undefined
    const end = outcome === 'interruption' ? session?.lastEndedChild : undefined
    const read = requestFailureReader(this.baselines, sessionId, baseline, releasedReport)
    this.deps.onFailure({
      sessionId,
      agent: journal.agent,
      kind: request.kind,
      id: request.id,
      outcome,
      death: end && { ...end, ...this.deps.wordsContext?.(sessionId) },
      capturePendingOutput: () =>
        clientMessageId && generation && fence !== undefined
          ? this.deps.capturePendingOutput?.({ sessionId, clientMessageId, fence, generation })
          : undefined,
      read
    })
  }
}
