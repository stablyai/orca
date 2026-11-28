import { PrioritySemaphore } from '../../../shared/concurrency/priority-semaphore'

const MiB = 1024 * 1024

/** Logical retained-byte and object budget. Not a bound on V8 RSS or native socket buffers. */
export class RexMemoryBudget {
  private bytes = 0
  private objects = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxObjects: number
  ) {}

  reserve(bytes: number): (() => void) | undefined {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.maxBytes - this.bytes ||
      this.objects >= this.maxObjects
    ) {
      return undefined
    }
    this.bytes += bytes
    this.objects++
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.bytes -= bytes
      this.objects--
    }
  }

  usage(): { bytes: number; objects: number } {
    return { bytes: this.bytes, objects: this.objects }
  }
}

// Keep control capacity separate so a flood cannot prevent inspection or close RPCs.
export const rexDataReceiveBudget = new RexMemoryBudget(64 * MiB, 32768)
export const rexControlReceiveBudget = new RexMemoryBudget(8 * MiB, 8192)
export const rexPendingRpcBudget = new RexMemoryBudget(16 * MiB, 4096)
export const rexSendBudget = new RexMemoryBudget(16 * MiB, 8192)
export const rexDataWireBudget = new RexMemoryBudget(0, 128)
export const rexControlWireBudget = new RexMemoryBudget(0, 256)

/** Bounded FIFO admission: don't accumulate snapshots or workers while waiting. */
export class RexJobBudget {
  private readonly semaphore: PrioritySemaphore
  private readonly admission: RexMemoryBudget

  constructor(
    maxActive: number,
    maxWaiting = 32,
    private readonly waitMs = 15_000
  ) {
    this.semaphore = new PrioritySemaphore(maxActive)
    this.admission = new RexMemoryBudget(0, maxActive + maxWaiting)
  }

  async acquire(): Promise<() => void> {
    const releaseAdmission = this.admission.reserve(0)
    if (!releaseAdmission) {
      throw new Error('Rex snapshot job queue full')
    }
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new Error('Rex snapshot job admission timed out')),
      this.waitMs
    )
    try {
      // Equal priority is FIFO; both underlying releases are idempotent.
      const release = await this.semaphore.acquire(0, deadline.signal)
      return () => {
        release()
        releaseAdmission()
      }
    } catch (error) {
      releaseAdmission()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

export const rexSnapshotJobs = new RexJobBudget(2)
export const rexDecoderJobs = new RexJobBudget(2)
export const REX_MAX_SNAPSHOT_BYTES = 16 * MiB
