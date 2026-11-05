import {
  yieldJournalHost,
  finishJournalSteps,
  finishJournalStepsAsync
} from '../agent-session-journal/journal-reconstruction-steps'
import { agentTurnVerdict } from '../../../shared/agent-status/lifecycle/agent-turn-outcome'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  isStructuredAgentSessionCommandTurn,
  isStructuredAgentSessionCommandEntry
} from '../../../shared/agent-session/structured-agent-session-command-entry'
import { classifyDispatchRejection } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'

import type {
  StructuredAgentSessionRequestFailure,
  Baseline,
  StructuredRequestFailureDeps
} from './structured-agent-session-request-failure-types'
export type { StructuredAgentSessionRequestFailure } from './structured-agent-session-request-failure-types'

/** Live request edges use the journal's fold before the latest-only publications can coalesce. */
export class StructuredAgentSessionRequestFailures {
  private readonly baselines = new Map<string, Baseline>()

  constructor(private readonly deps: StructuredRequestFailureDeps) {}

  forget = (sessionId: string): void => {
    this.baselines.delete(sessionId)
  }
  clear = (): void => this.baselines.clear()

  observe = (
    sessionId: string,
    journal: AgentSessionJournal,
    rows?: readonly JournalRow[],
    _replacement?: boolean
  ): void => {
    finishJournalSteps(this.observeSteps(sessionId, journal, rows))
  }

  observeAsync = async (
    sessionId: string,
    journal: AgentSessionJournal,
    rows?: readonly JournalRow[]
  ): Promise<void> => {
    const initiallyEnded = this.deps.sessions.get(sessionId)?.lastEndedChild
    for (;;) {
      const session = this.deps.sessions.get(sessionId)
      if (session?.journal !== journal) {
        return
      }
      const previous = this.baselines.get(sessionId)
      const ended = session.lastEndedChild
      const child = session.child
      const revision = session.operationalRevision
      const current = () =>
        this.deps.sessions.get(sessionId) === session &&
        session.journal === journal &&
        session.lastEndedChild === ended &&
        session.child === child &&
        session.operationalRevision === revision &&
        this.baselines.get(sessionId) === previous
      const installed = await finishJournalStepsAsync(
        this.observeSteps(sessionId, journal, rows, current)
      )
      if (
        installed &&
        this.deps.sessions.get(sessionId) === session &&
        session.journal === journal
      ) {
        const baseline = this.baselines.get(sessionId)
        if (baseline) {
          baseline.ended = initiallyEnded
        }
        this.generationEnded(sessionId)
        return
      }
      await yieldJournalHost()
    }
  };

  private *observeSteps(
    sessionId: string,
    journal: AgentSessionJournal,
    rows?: readonly JournalRow[],
    current?: () => boolean
  ): Generator<void, boolean> {
    const cursor = journal.cursor()
    let baseline = this.baselines.get(sessionId)
    const items = new Set<string>()
    const submissions = new Set<string>()
    let cleared = false
    for (const row of rows ?? []) {
      if (row.kind === 'dispatch' || row.kind === 'submission') {
        submissions.add(row.clientMessageId)
      }
      const mutations = row.kind === 'lifecycle-batch' ? row.mutations : [row]
      yield
      for (const mutation of mutations) {
        yield
        if (mutation.kind !== 'item' && mutation.kind !== 'tombstone') {
          continue
        }
        const id = journal.canonicalItemId(mutation.itemId)
        items.add(id)
        const scope = journal.item(id)?.turnScope
        if (scope?.kind === 'turn') {
          items.add(scope.turnItemId)
        }
        if (isAgentSessionContextClear(journal.itemBody(id) ?? undefined)) {
          cleared = true
        }
      }
    }
    const replaced =
      !rows ||
      !baseline ||
      baseline.journal !== journal ||
      baseline.epoch !== cursor.epoch ||
      cursor.sequence < baseline.sequence
    const historical = Boolean(current) || replaced || cleared
    if (historical) {
      // Context clear retires marks, while captured reads still belong to the held journal.
      baseline = Object.assign(replaced || current ? {} : (baseline ?? {}), {
        ...cursor,
        sessionId,
        journal,
        floor: journal.context.floor()?.sequence ?? 0,
        marks: new Map(),
        ended: this.deps.sessions.get(sessionId)?.lastEndedChild
      })
      yield* journal.visitItemSteps((id) => {
        items.add(id)
      })
      for (const itemId of items) {
        yield
        const submission = journal.inputOrder.inputForItem(itemId)
        if (submission) {
          submissions.add(submission.clientMessageId)
        }
      }
    }
    if (!baseline) {
      return true
    }
    baseline.sequence = cursor.sequence
    for (const id of items) {
      yield
      this.account(sessionId, baseline, this.request(baseline, 'turn', id), historical)
    }
    for (const id of submissions) {
      yield
      this.account(sessionId, baseline, this.request(baseline, 'refused-send', id), historical)
    }
    if (current && !current()) {
      return false
    }
    this.baselines.set(sessionId, baseline)
    return true
  }

  generationEnded = (sessionId: string): void => {
    const baseline = this.baselines.get(sessionId)
    const session = this.deps.sessions.get(sessionId)
    const ended = session?.lastEndedChild
    if (
      !baseline ||
      !session ||
      baseline.journal !== session.journal ||
      baseline.epoch !== session.journal.epoch ||
      baseline.ended === ended
    ) {
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
  ): {
    kind: StructuredAgentSessionRequestFailure['kind']
    id: string
    mark: string
  } | null {
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
            mark: failed ? 'failure' : submission.dispatchState
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
      mark: verdict === 'interruption' && !unexpected ? turn.state : (verdict ?? turn.state)
    }
  }

  private account(
    sessionId: string,
    baseline: Baseline,
    request: ReturnType<StructuredAgentSessionRequestFailures['request']>,
    historical: boolean
  ): void {
    if (!request) {
      return
    }
    const key = `${request.kind}:${request.id}`
    const previous = baseline.marks.get(key)
    baseline.marks.set(key, request.mark)
    const outcome = request.mark
    if (
      historical ||
      previous === 'failure' ||
      previous === 'interruption' ||
      (outcome !== 'failure' && outcome !== 'interruption')
    ) {
      return
    }
    const { journal, epoch } = baseline
    const session = this.deps.sessions.get(sessionId)
    const child = session?.child
    const fence = journal.itemFence(request.id)
    const opener = journal.canonicalItemId(
      (request.kind === 'turn'
        ? readAgentJournalTurn(journal.itemBody(request.id) ?? undefined)?.userItemId
        : request.id) ?? ''
    )
    const { clientMessageId } = journal.inputOrder.inputForItem(opener) ?? {}
    const generation = child?.fence === fence ? child?.generation : undefined
    const end = outcome === 'interruption' ? session?.lastEndedChild : undefined
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
      read: () =>
        journal.readInOrder(() =>
          this.baselines.get(sessionId) === baseline && journal.epoch === epoch
            ? journal.snapshot()
            : null
        )
    })
  }
}
