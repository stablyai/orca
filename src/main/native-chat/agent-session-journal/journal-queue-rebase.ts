import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalQueueRestatement } from './journal-queued-messages'
import {
  finishJournalSteps,
  finishJournalStepsAsync,
  sortJournalSteps
} from './journal-reconstruction-steps'

type Position = { sequence: number; rebased: number }

class JournalQueueRebase {
  private readonly comparableByEpoch = new Map<string, Position[]>()
  private originalPositions: Map<string, Position[]> | undefined

  constructor(
    private readonly acceptance: (id: string) => AgentJournalCursor | undefined,
    private readonly epoch: string,
    private readonly previousEpoch: string | undefined,
    private readonly queued: readonly AgentJournalSubmission[],
    private readonly rebuilt: ReadonlyMap<string, number>
  ) {}

  private *originals(): Generator<void, Map<string, Position[]>> {
    if (!this.originalPositions) {
      this.originalPositions = new Map()
      for (const submission of this.queued) {
        const original = this.acceptance(submission.clientMessageId)
        if (original) {
          const positions = this.originalPositions.get(original.epoch) ?? []
          positions.push({
            sequence: original.sequence,
            rebased: this.rebuilt.get(submission.clientMessageId) ?? 1
          })
          this.originalPositions.set(original.epoch, positions)
        }
        yield
      }
    }
    return this.originalPositions
  }

  *prepare(epochs: Iterable<string>): Generator<void> {
    if (this.previousEpoch === undefined) {
      return
    }
    for (const epoch of epochs) {
      if (this.comparableByEpoch.has(epoch)) {
        continue
      }
      let comparable: Position[]
      if (epoch === this.previousEpoch) {
        const current: Position[] = []
        const missing = new Set<number | undefined>()
        for (const submission of this.queued) {
          if (submission.acceptedSequence === undefined) {
            missing.add(this.rebuilt.get(submission.clientMessageId))
          } else {
            current.push({
              sequence: submission.acceptedSequence,
              rebased: this.rebuilt.get(submission.clientMessageId) ?? 1
            })
          }
          yield
        }
        comparable = current
        if (current.length !== this.queued.length) {
          for (const position of (yield* this.originals()).get(epoch) ?? []) {
            if (missing.has(position.rebased)) {
              comparable.push(position)
            }
            yield
          }
        }
      } else {
        comparable = (yield* this.originals()).get(epoch) ?? []
      }
      comparable = yield* sortJournalSteps(comparable, (a, b) => a.sequence - b.sequence)
      for (let i = 1; i < comparable.length; i++) {
        comparable[i].rebased = Math.max(comparable[i].rebased, comparable[i - 1].rebased)
        yield
      }
      this.comparableByEpoch.set(epoch, comparable)
    }
  }

  rebase = (queuedAt: AgentJournalCursor | null): AgentJournalCursor | null => {
    if (!queuedAt || this.previousEpoch === undefined) {
      return queuedAt
    }
    finishJournalSteps(this.prepare([queuedAt.epoch]))
    const comparable = this.comparableByEpoch.get(queuedAt.epoch)!
    if (comparable.length !== this.queued.length) {
      return queuedAt
    }
    let low = 0
    let high = comparable.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (comparable[mid].sequence <= queuedAt.sequence) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return { epoch: this.epoch, sequence: low === 0 ? 1 : comparable[low - 1].rebased }
  }
}

export function journalQueueRebaseWithAcceptance(
  ...input: ConstructorParameters<typeof JournalQueueRebase>
): (queuedAt: AgentJournalCursor | null) => AgentJournalCursor | null {
  return new JournalQueueRebase(...input).rebase
}

export async function prepareJournalQueueRebaseWithAcceptance(
  acceptance: (id: string) => AgentJournalCursor | undefined,
  epoch: string,
  previousEpoch: string | undefined,
  queued: readonly AgentJournalSubmission[],
  rebuilt: ReadonlyMap<string, number>,
  cards: JournalQueueRestatement['cards']
): Promise<(queuedAt: AgentJournalCursor | null) => AgentJournalCursor | null> {
  const owner = new JournalQueueRebase(acceptance, epoch, previousEpoch, queued, rebuilt)
  function* prepare(): Generator<void> {
    for (const { change } of cards) {
      if (change?.op === 'queued' && change.queuedAt) {
        yield* owner.prepare([change.queuedAt.epoch])
      }
      yield
    }
  }
  await finishJournalStepsAsync(prepare())
  return owner.rebase
}
