import { awaitDaemonValueWithinCallerDeadline } from '../../launch/daemon-request-deadline'
import type { TerminalHistoryRoot } from './terminal-history-root'

const WRITER_ADMISSION_TIMEOUT_MS = 15_000
export type HistoryWriterAdmission<T> = { entered: true; value: T } | { entered: false }
export type HistoryWriterPreparation = {
  deadlineMs?: number
  prepare: () => Promise<unknown> | undefined
  abandon: () => void
}

/** Abandon waiting ownership without canceling persistence still owned by its predecessor. */
export class TerminalHistoryWriterAdmissions {
  private closed = false
  private readonly pending = new Set<() => void>()

  constructor(private readonly root: TerminalHistoryRoot | null) {}

  isOpen = (): boolean => !this.closed

  close(): void {
    this.closed = true
    for (const abandon of this.pending) {
      abandon()
    }
  }

  acquire<T>(
    id: string,
    preparation: HistoryWriterPreparation,
    operation: (deadlineMs: number) => T | Promise<T>
  ): Promise<HistoryWriterAdmission<T>> {
    const deadlineMs = preparation.deadlineMs ?? Date.now() + WRITER_ADMISSION_TIMEOUT_MS
    if (this.closed || Date.now() >= deadlineMs) {
      preparation.abandon()
      return Promise.resolve({ entered: false })
    }
    const admission = this.root?.admitWriter(id)
    let current = true
    let entered = false
    let canceled!: () => void
    const cancellation = new Promise<undefined>((resolve) => {
      canceled = () => resolve(undefined)
    })
    const abandon = (): void => {
      if (!current || entered) {
        return
      }
      current = false
      this.pending.delete(abandon)
      admission?.release()
      preparation.abandon()
      canceled()
    }
    this.pending.add(abandon)
    const run = (): Promise<HistoryWriterAdmission<T>> => {
      if (!current || this.closed || admission?.current() === false || Date.now() >= deadlineMs) {
        abandon()
        return Promise.resolve({ entered: false })
      }
      entered = true
      this.pending.delete(abandon)
      try {
        return Promise.resolve(operation(deadlineMs))
          .then((value) => ({ entered: true as const, value }))
          .finally(() => admission?.release())
      } catch (error) {
        admission?.release()
        return Promise.reject(error)
      }
    }
    try {
      const prepared = preparation.prepare()
      const waits = [admission?.ready, prepared].filter((work) => work !== undefined)
      if (!waits.length) {
        return run()
      }
      const ready = Promise.all(waits).then(() => true)
      return awaitDaemonValueWithinCallerDeadline(Promise.race([ready, cancellation]), deadlineMs)
        .then((result) => {
          if (result.completed && result.value === true) {
            return run()
          }
          abandon()
          return { entered: false as const }
        })
        .catch((error: unknown) => {
          abandon()
          throw error
        })
    } catch (error) {
      abandon()
      return Promise.reject(error)
    }
  }
}
