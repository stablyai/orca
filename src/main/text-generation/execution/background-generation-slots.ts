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

type Waiter = {
  grant: () => void
  queue: WaiterQueue | null
  prev: Waiter | null
  next: Waiter | null
}

/** FIFO of waiters; each waiter sits in at most one queue, so promotion and grants are O(1). */
class WaiterQueue {
  private head: Waiter | null = null
  private tail: Waiter | null = null

  push(waiter: Waiter): void {
    waiter.queue = this
    waiter.prev = this.tail
    waiter.next = null
    if (this.tail) {
      this.tail.next = waiter
    } else {
      this.head = waiter
    }
    this.tail = waiter
  }

  remove(waiter: Waiter): void {
    if (waiter.prev) {
      waiter.prev.next = waiter.next
    } else {
      this.head = waiter.next
    }
    if (waiter.next) {
      waiter.next.prev = waiter.prev
    } else {
      this.tail = waiter.prev
    }
    waiter.queue = waiter.prev = waiter.next = null
  }

  shift(): Waiter | null {
    const waiter = this.head
    if (waiter) {
      this.remove(waiter)
    }
    return waiter
  }
}

let running = 0
const userRequests = new WaiterQueue()
const backgroundRuns = new WaiterQueue()

function releaseSlot(): void {
  const next = userRequests.shift() ?? backgroundRuns.shift()
  if (next) {
    next.grant()
  } else {
    running--
  }
}

/**
 * One naming request's admissions, across its retries. User requests run before automatic ones,
 * each in arrival order; `promote` moves a queued automatic admission to the user queue's tail.
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
    const waiter = this.queued
    if (waiter?.queue === backgroundRuns) {
      backgroundRuns.remove(waiter)
      userRequests.push(waiter)
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
        queue: null,
        prev: null,
        next: null,
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
