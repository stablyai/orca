import { withEvidenceBudget } from '../../../shared/process-table-snapshot-reader'
import type { TerminalInterfaceBinding } from '../../../shared/terminal-interface-observation'
import type { TerminalProcessInspection } from '../../../shared/terminal-process-inspection'
import type { Entry, Lease } from './terminal-interface-contracts'

type InspectionSuccessor = {
  promise: Promise<TerminalProcessInspection | null>
  run: () => Promise<TerminalProcessInspection | null>
  resolve: (result: TerminalProcessInspection | null) => void
}
type InspectionEntry = {
  running: Promise<TerminalProcessInspection | null>
  next?: InspectionSuccessor
}

export class TerminalInterfaceProbe {
  running = 0
  private readonly inspections = new Map<string, InspectionEntry>()
  sampleDue(
    entries: Iterable<Entry>,
    now: number,
    sample: (entry: Entry, changed: () => void) => Promise<void>,
    onChanged: () => void
  ): void {
    const due = [...entries]
      .filter(
        (entry) => !entry.target.blocked && entry.target.local && !entry.pending && entry.due <= now
      )
      .sort((left, right) => left.due - right.due)
    let changed = false
    const markChanged = () => {
      changed = true
    }
    // A due wave publishes one complete replacement after its bounded readers settle.
    void Promise.all(
      (process.platform === 'win32' ? due.slice(0, Math.max(0, 2 - this.running)) : due).map(
        (entry) => sample(entry, markChanged)
      )
    ).then(() => {
      if (changed) {
        onChanged()
      }
    })
  }

  /** Both provider waits and presence probes have a deadline; disposal also releases the lease. */
  async bounded<T>(lease: Lease, pending: Promise<T>): Promise<T> {
    let abort: () => void = () => {}
    try {
      return await withEvidenceBudget(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('terminal interface driver disposed'))
            lease.controller.signal.addEventListener('abort', abort, { once: true })
            if (lease.controller.signal.aborted) {
              abort()
            }
          })
        ])
      )
    } finally {
      lease.controller.signal.removeEventListener('abort', abort)
    }
  }

  /** A timed-out waiter never starts duplicate provider work while its bounded capture settles. */
  inspect(
    lease: Lease,
    binding: TerminalInterfaceBinding,
    steadyState: boolean
  ): Promise<TerminalProcessInspection | null> {
    const key = JSON.stringify([binding.ptyId, binding.incarnationId])
    const run = async (): Promise<TerminalProcessInspection | null> => {
      if (lease.controller.signal.aborted) {
        return null
      }
      this.running += 1
      try {
        return await lease.driver.inspect(binding, steadyState)
      } finally {
        this.running -= 1
      }
    }
    const existing = this.inspections.get(key)
    if (existing) {
      if (!existing.next) {
        existing.next = {
          ...Promise.withResolvers<TerminalProcessInspection | null>(),
          run
        }
      }
      existing.next.run = run
      return existing.next.promise
    }
    const entry: InspectionEntry = {
      running: Promise.resolve()
        .then(run)
        .catch(() => null)
    }
    this.inspections.set(key, entry)
    const settle = (): void => {
      const next = entry.next
      entry.next = undefined
      if (!next) {
        if (this.inspections.get(key) === entry) {
          this.inspections.delete(key)
        }
        return
      }
      entry.running = Promise.resolve()
        .then(next.run)
        .catch(() => null)
      void entry.running.then(next.resolve).then(settle)
    }
    void entry.running.then(settle)
    return entry.running
  }
}
