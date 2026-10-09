// The reconciliation workers' few background slots, for a chat's replay and its startup recovery
// step: outside every chat's lane, so a send or a read never waits behind the scan. A chat a reader
// opened goes ahead of the rest; a quit ends every wait, and a task it has not started never runs.

import { PrioritySemaphore } from '../../../shared/priority-semaphore'

const BACKGROUND_SLOTS = 4
const URGENT = 0
const SCAN = 1

/** One chat's place in line. */
export type StructuredAgentSessionReconciliationSlotWaiter = {
  /** Goes ahead of the startup scan: a reader opened the chat. */
  urgent: boolean
  /** The wait in progress, aborted to requeue it ahead or to quit. */
  slotWait?: AbortController
}

export class StructuredAgentSessionReconciliationSlots {
  private readonly slots = new PrioritySemaphore(BACKGROUND_SLOTS)

  constructor(private readonly disposed: () => boolean) {}

  /** Requeues the chat's wait ahead of the scan. */
  prioritize(waiter: StructuredAgentSessionReconciliationSlotWaiter): void {
    if (!waiter.urgent) {
      waiter.urgent = true
      waiter.slotWait?.abort()
    }
  }

  /** Runs the task in a slot; null when quit came first, and the task never ran. */
  async run<T>(
    waiter: StructuredAgentSessionReconciliationSlotWaiter,
    task: () => Promise<T>
  ): Promise<{ value: T } | null> {
    let release: (() => void) | null = null
    while (!release) {
      if (this.disposed()) {
        return null
      }
      const wait = new AbortController()
      waiter.slotWait = wait
      // Aborted to requeue ahead or to quit: the loop decides which.
      release = await this.slots
        .acquire(waiter.urgent ? URGENT : SCAN, wait.signal)
        .catch(() => null)
      waiter.slotWait = undefined
    }
    try {
      return this.disposed() ? null : { value: await task() }
    } finally {
      release()
    }
  }
}
