import type { StructuredAgentSessionEventTarget } from './structured-agent-session-event-sink'
import type {
  JournalWriterStep,
  JournalStepsResult
} from '../../agent-session-journal/writing/journal-writer-step'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'

export type StructuredAgentSessionSinkOperation = {
  sequence: number
  bytes: number
  operations?: number
  workOperations?: number
  /** Only publications coalesce by key; replacing journal writes would reorder them behind later work. */
  publicationKey?: string
  /** Handover synchronously joins the journal queue in submission order. */
  run?: (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void
  steps?: (target: StructuredAgentSessionEventTarget) => readonly JournalWriterStep[]
  onResolved?: (result: JournalStepsResult) => void
}

export type Admitted = StructuredAgentSessionSinkOperation & { superseded?: boolean }

/** Capture a complete synchronous source unit; ready-batch caps never divide its dependencies. */
export class StructuredAgentSessionDispatch {
  queuedWorkOperations = 0
  private pending: Admitted[] = []
  private readonly waitingPublications = new Map<string, Admitted>()
  constructor(
    private readonly flush: () => void,
    private readonly canPublish: () => boolean,
    private readonly workChanged?: () => void
  ) {}

  coalesce(operation: Admitted, replaced?: Admitted): void {
    this.changeWork(sinkWorkOperations(operation) - (replaced ? sinkWorkOperations(replaced) : 0))
    const key = operation.publicationKey
    if (key !== undefined) {
      const prior = this.waitingPublications.get(key)
      if (prior) {
        prior.superseded = true
      }
      this.waitingPublications.set(key, operation)
    }
  }

  release(operation: Admitted): void {
    this.forget(operation)
    this.changeWork(-sinkWorkOperations(operation))
  }

  private changeWork(change: number): void {
    if (change !== 0) {
      this.queuedWorkOperations += change
      this.workChanged?.()
    }
  }

  forget(operation: Admitted): void {
    const key = operation.publicationKey
    if (key !== undefined && this.waitingPublications.get(key) === operation) {
      this.waitingPublications.delete(key)
    }
  }

  push(operation: Admitted): void {
    if (this.pending.length === 0) {
      const pending = this.pending
      queueMicrotask(() => {
        if (this.pending === pending) {
          this.flush()
        }
      })
    }
    this.pending.push(operation)
  }

  take(): Admitted[] {
    const pending = this.pending
    this.pending = []
    return pending
  }

  seal(bound: StructuredAgentSessionEventTarget): StructuredAgentSessionSinkOperation | undefined {
    const dispatch = this.take()
    if (dispatch.length === 0) {
      return undefined
    }
    const prepared = dispatch.map((operation) => ({ operation, steps: operation.steps?.(bound) }))
    const steps = prepared.flatMap((entry) => entry.steps ?? [])
    const run = async () => {
      const result = steps.length
        ? await bound.journal.appendSteps(steps)
        : await bound.journal.readInOrder((): JournalStepsResult => ({ outcomes: [] }))
      let offset = 0
      for (const { operation, steps: selected } of prepared) {
        if (selected) {
          const count = selected.length
          const outcomes = result.outcomes.slice(offset, offset + count)
          if (outcomes.length) {
            operation.onResolved?.({ ...result, outcomes })
          }
          offset += count
        } else if (
          !operation.superseded &&
          this.canPublish() &&
          (!result.failure ||
            result.outcomes.some((outcome) => outcome.kind === 'committed' && outcome.wrote))
        ) {
          await operation.run?.(bound)
        }
      }
      if (result.failure) {
        throw restoreJournalSqlFailure(result.failure)
      }
    }
    return {
      sequence: dispatch.at(-1)!.sequence,
      bytes: dispatch.reduce((total, operation) => total + operation.bytes, 0),
      operations: dispatch.reduce((total, operation) => total + (operation.operations ?? 1), 0),
      workOperations: dispatch.reduce(
        (total, operation) => total + sinkWorkOperations(operation),
        0
      ),
      run: () =>
        run().finally(() => {
          for (const operation of dispatch) {
            this.forget(operation)
          }
        })
    }
  }
}

export function runStructuredAgentSessionSinkOperation(
  operation: StructuredAgentSessionSinkOperation,
  target: StructuredAgentSessionEventTarget
): Promise<unknown> {
  try {
    return Promise.resolve(operation.run?.(target))
  } catch (error) {
    return Promise.reject(error)
  }
}

function sinkWorkOperations(operation: StructuredAgentSessionSinkOperation): number {
  return (
    operation.workOperations ??
    (operation.publicationKey === undefined ? (operation.operations ?? 1) : 0)
  )
}
