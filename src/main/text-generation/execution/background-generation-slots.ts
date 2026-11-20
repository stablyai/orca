import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'

/** Each background generation starts an agent CLI from main; a launch burst must not start one per chat at once. */
const MAX_RUNNING = 3
/** The CLI's own deadline stops it first; only a child whose termination failed holds a slot this long. */
const SLOT_HOLD_LIMIT_MS = SOURCE_CONTROL_GENERATION_TIMEOUT_MS + 15_000

type Execution = { processClosed: Promise<unknown> }

/**
 * Starts a generation once a slot frees and holds the slot until its processes close; the result
 * itself is not delayed. Null when the request was no longer wanted by the time the slot freed.
 * Callers enter after any account lock, so a lock wait holds no slot.
 */
export type GenerationAdmission = <E extends Execution>(
  start: () => E | Promise<E>
) => Promise<E | null>

type Waiter = { grant: () => void; granted: boolean }

class FifoQueue {
  private items: Waiter[] = []
  private head = 0

  push(waiter: Waiter): void {
    this.items.push(waiter)
  }

  /** Removes and returns the oldest waiter the other queue has not already granted. */
  take(): Waiter | undefined {
    while (this.head < this.items.length) {
      const waiter = this.items[this.head++]
      if (this.head > 64 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head)
        this.head = 0
      }
      if (!waiter.granted) {
        return waiter
      }
    }
    return undefined
  }
}

let running = 0
const userRequests = new FifoQueue()
const backgroundRuns = new FifoQueue()

function releaseSlot(): void {
  const next = userRequests.take() ?? backgroundRuns.take()
  if (next) {
    next.granted = true
    next.grant()
  } else {
    running--
  }
}

/**
 * One naming request's admissions, across its retries. User requests run before automatic ones,
 * each in arrival order; `promote` moves a queued automatic admission into the user queue.
 */
export class BackgroundGenerationRequest {
  private userRequested: boolean
  private queued: Waiter | null = null

  constructor(userRequested = false) {
    this.userRequested = userRequested
  }

  promote(): void {
    if (this.userRequested) {
      return
    }
    this.userRequested = true
    // A promoted waiter sits in both queues; whichever reaches it first grants it.
    if (this.queued) {
      userRequests.push(this.queued)
    }
  }

  /** An admission that starts nothing once `stillWanted` is false when its slot frees. */
  admitWhile(stillWanted: () => boolean): GenerationAdmission {
    return (start) => this.admit(start, stillWanted)
  }

  private async admit<E extends Execution>(
    start: () => E | Promise<E>,
    stillWanted: () => boolean
  ): Promise<E | null> {
    await this.acquire()
    let released = false
    const release = (): void => {
      if (!released) {
        released = true
        clearTimeout(timer)
        releaseSlot()
      }
    }
    const timer = setTimeout(release, SLOT_HOLD_LIMIT_MS)
    try {
      if (!stillWanted()) {
        release()
        return null
      }
      const execution = await start()
      void execution.processClosed.then(release, release)
      return execution
    } catch (error) {
      release()
      throw error
    }
  }

  private acquire(): Promise<void> {
    if (running < MAX_RUNNING) {
      running++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        granted: false,
        grant: () => {
          this.queued = null
          resolve()
        }
      }
      this.queued = waiter
      ;(this.userRequested ? userRequests : backgroundRuns).push(waiter)
    })
  }
}
