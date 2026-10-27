import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
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
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
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

type Baseline = ReturnType<AgentSessionJournal['cursor']> & {
  sessionId: string
  journal: AgentSessionJournal
  floor: number
  marks: Map<string, string>
  ended: StructuredAgentSessionHostSession['lastEndedChild']
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

  forget = (sessionId: string): void => {
    this.baselines.delete(sessionId)
  }
  clear = (): void => this.baselines.clear()

  observe = (
    sessionId: string,
    journal: AgentSessionJournal,
    rows?: readonly JournalRow[]
  ): void => {
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
      for (const mutation of mutations) {
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
    const historical = replaced || cleared
    if (historical) {
      // Context clear retires marks, while captured reads still belong to the held journal.
      baseline = Object.assign(replaced ? {} : (baseline ?? {}), {
        ...cursor,
        sessionId,
        journal,
        floor: journal.context.floor()?.sequence ?? 0,
        marks: new Map(),
        ended: this.deps.sessions.get(sessionId)?.lastEndedChild
      })
      this.baselines.set(sessionId, baseline)
      journal.visitItems((id) => items.add(id))
      for (const submission of journal.submissions()) {
        submissions.add(submission.clientMessageId)
      }
    }
    if (!baseline) {
      return
    }
    baseline.sequence = cursor.sequence
    for (const id of items) {
      this.account(sessionId, baseline, this.request(baseline, 'turn', id), historical)
    }
    for (const id of submissions) {
      this.account(sessionId, baseline, this.request(baseline, 'refused-send', id), historical)
    }
  }

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
    const { clientMessageId } =
      journal
        .submissions()
        .find(({ clientMessageId: id }) => agentJournalSubmissionKey(id) === opener) ?? {}
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
