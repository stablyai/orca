import { TerminalShellCleanExitConfirmation } from './terminal-shell-clean-exit-confirmation'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'
import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
import type { TerminalOwner } from '../../shared/terminal-owner'

// Bound proof latency and queued output; timeout or overflow releases the original stream.
const MAX_QUEUED_BYTES = 262_144
const MAX_PENDING_MS = 750
// Keep the reset’s indivisible source span small enough for relay delivery.
const MAX_HELD_MARK_CHARS = 4096

export type TerminalShellRecoveryBarrierOptions = {
  /** Fresh execution-host proof that the spawned shell owns the PTY foreground. */
  confirmShellForeground: () => Promise<boolean>
  /** Ordered downstream sink (emulator write + record + client broadcast). */
  release: (emission: PtyIngressEmission) => void
  isAlive: () => boolean
  maxQueuedBytes?: number
  maxPendingMs?: number
}

/** Hold suspected-death output for foreground proof; attach resets to a raw marker so relay credit and snapshot dedup retain them. */
export class TerminalShellRecoveryBarrier {
  private readonly scanner = new TerminalShellLifecycleScanner()
  private readonly confirmShellForeground: () => Promise<boolean>
  private readonly releaseDownstream: (emission: PtyIngressEmission) => void
  private readonly isAlive: () => boolean
  private readonly maxQueuedBytes: number
  private readonly maxPendingMs: number

  private queue: PtyIngressEmission[] = []
  private queuedBytes = 0
  private pending = false
  private pendingGeneration = 0
  private pendingEpisode = 0
  private bailTimer: ReturnType<typeof setTimeout> | null = null
  private idleWaiters: (() => void)[] = []
  private readonly cleanExit: TerminalShellCleanExitConfirmation
  private disposed = false

  constructor(opts: TerminalShellRecoveryBarrierOptions) {
    this.confirmShellForeground = opts.confirmShellForeground
    this.releaseDownstream = opts.release
    this.isAlive = opts.isAlive
    this.maxQueuedBytes = opts.maxQueuedBytes ?? MAX_QUEUED_BYTES
    this.maxPendingMs = opts.maxPendingMs ?? MAX_PENDING_MS
    this.cleanExit = new TerminalShellCleanExitConfirmation({
      scanner: this.scanner,
      confirmShellForeground: opts.confirmShellForeground,
      deadlineMs: () => this.maxPendingMs,
      isDisposed: () => this.disposed,
      isAlive: opts.isAlive
    })
  }

  accept(emission: PtyIngressEmission): void {
    if (this.disposed) {
      return
    }
    if (this.pending) {
      this.enqueue(emission)
      return
    }
    this.scanAndRelease(emission)
  }

  getOwner(): TerminalOwner | undefined {
    return this.scanner.owner
  }

  /** Return a local ground without broadcasting; relay credit and snapshot dedup drop zero-raw resets. */
  groundInputModes(): string {
    return this.scanner.groundProcessBoundary()
  }

  /** Reuse settled barrier evidence because downstream consumers cannot be ahead of its scan position. */
  async confirmOwnerSettled(): Promise<boolean> {
    if (this.scanner.owner === 'shell') {
      return true
    }
    await this.awaitProofSettled()
    return this.scanner.owner === 'shell'
  }

  /** Flush before final snapshots; cap nested rescans so teardown cannot spin forever. */
  flushPending(): void {
    for (let guard = 0; this.pending && guard < 16; guard += 1) {
      this.finishPending(this.pendingEpisode, false)
    }
    if (!this.pending) {
      return
    }
    // After 16 nested episodes, preserve queued bytes without rescanning; ownership may remain stale.
    const queued = this.queue
    this.queue = []
    this.queuedBytes = 0
    this.pending = false
    if (this.bailTimer) {
      clearTimeout(this.bailTimer)
      this.bailTimer = null
    }
    for (const emission of queued) {
      try {
        this.releaseDownstream(emission)
      } catch {
        // One throwing client must not cost the rest of the queue its delivery.
      }
    }
    this.resolveIdleWaiters()
  }

  /** Resolve at each episode boundary so repeated triggers cannot starve an attach. */
  idle(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Bound waits for recovery and clean-exit proofs; a newer generation makes the requested proof stale. */
  async awaitProofSettled(): Promise<void> {
    const target = this.scanner.generation
    let deadlineHit = false
    const deadline = setTimeout(() => {
      deadlineHit = true
      this.resolveIdleWaiters()
      this.cleanExit.drainWaiters()
    }, this.maxPendingMs)
    deadline.unref?.()
    try {
      while (
        (this.pending || this.cleanExit.inFlight) &&
        this.scanner.generation <= target &&
        !this.disposed &&
        !deadlineHit
      ) {
        await (this.pending ? this.idle() : this.cleanExit.waitSettled())
      }
    } finally {
      clearTimeout(deadline)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.bailTimer) {
      clearTimeout(this.bailTimer)
      this.bailTimer = null
    }
    // Callers must flush before disposal; no live sink remains for queued output.
    this.queue = []
    this.queuedBytes = 0
    this.pending = false
    this.resolveIdleWaiters()
    this.cleanExit.drainWaiters()
  }

  private scanAndRelease(emission: PtyIngressEmission): void {
    const events = this.scanner.scan(emission.data)
    if (events.cleanExitCandidate) {
      this.cleanExit.start(events.cleanExitCandidate.generation)
    }
    const end = events.uncleanDeathTriggerEnd
    if (end === undefined) {
      this.releaseDownstream(emission)
      return
    }
    const splittable =
      end >= 1 &&
      !emission.transformed &&
      emission.rawEndSeq - emission.rawStartSeq === emission.data.length
    if (!splittable) {
      // Transformed spans lack a recoverable raw split point; release unchanged and scan the remainder.
      try {
        this.releaseDownstream(emission)
      } catch {
        // A client may throw after recording; the scanner must still advance.
      }
      this.consumeForStateOnly(emission.data.slice(end))
      return
    }
    const start = Math.max(events.uncleanDeathTriggerStart ?? 0, end - MAX_HELD_MARK_CHARS)
    const markSeq = emission.rawStartSeq + start
    const splitSeq = emission.rawStartSeq + end
    if (start > 0) {
      try {
        this.releaseDownstream({
          data: emission.data.slice(0, start),
          rawStartSeq: emission.rawStartSeq,
          rawEndSeq: markSeq,
          transformed: false
        })
      } catch {
        // A client failure must not prevent recovery of the remaining prompt.
      }
    }
    this.enterPending({
      data: emission.data.slice(start, end),
      rawStartSeq: markSeq,
      rawEndSeq: splitSeq,
      transformed: false
    })
    if (end < emission.data.length) {
      this.enqueue({
        data: emission.data.slice(end),
        rawStartSeq: splitSeq,
        rawEndSeq: emission.rawEndSeq,
        transformed: false
      })
    }
  }

  private consumeForStateOnly(data: string): void {
    let rest = data
    while (rest.length > 0) {
      const events = this.scanner.scan(rest)
      if (events.cleanExitCandidate) {
        this.cleanExit.start(events.cleanExitCandidate.generation)
      }
      if (events.uncleanDeathTriggerEnd === undefined) {
        return
      }
      rest = rest.slice(events.uncleanDeathTriggerEnd)
    }
  }

  private enterPending(mark: PtyIngressEmission): void {
    this.pending = true
    this.pendingEpisode += 1
    this.pendingGeneration = this.scanner.generation
    const episode = this.pendingEpisode
    this.bailTimer = setTimeout(() => this.finishPending(episode, false), this.maxPendingMs)
    this.bailTimer.unref?.()
    this.enqueue(mark)
    // Injected callbacks may throw synchronously; still settle the recovery episode.
    let proof: Promise<boolean>
    try {
      proof = this.confirmShellForeground()
    } catch {
      proof = Promise.resolve(false)
    }
    // Handle proof rejection before finishPending so its own exceptions cannot refute the episode again.
    void proof
      .then(
        (confirmed) => confirmed,
        () => false
      )
      .then((confirmed) => this.finishPending(episode, confirmed))
  }

  private finishPending(episode: number, confirmed: boolean): void {
    if (!this.pending || this.disposed || episode !== this.pendingEpisode) {
      return
    }
    this.pending = false
    if (this.bailTimer) {
      clearTimeout(this.bailTimer)
      this.bailTimer = null
    }
    const queued = this.queue
    this.queue = []
    this.queuedBytes = 0
    try {
      const mark = queued.shift()
      if (mark) {
        this.releaseMark(mark, confirmed && this.isAlive())
      }
      for (let index = 0; index < queued.length; index += 1) {
        if (this.disposed) {
          break
        }
        if (this.pending) {
          this.enqueue(queued[index]!)
          continue
        }
        try {
          this.scanAndRelease(queued[index]!)
        } catch {
          // A downstream failure must not prevent delivery of the remaining queue.
        }
      }
    } finally {
      // Always release attach waiters, including after downstream failures.
      this.resolveIdleWaiters()
    }
  }

  private releaseMark(mark: PtyIngressEmission, grounded: boolean): void {
    try {
      this.releaseDownstream(
        grounded
          ? {
              ...mark,
              // Ground the scanner before downstream consumers see the reset.
              data: mark.data + this.scanner.groundProcessBoundary(),
              transformed: true
            }
          : mark
      )
    } catch {
      // A downstream failure must not strand the remaining prompt bytes.
    }
    if (grounded) {
      this.scanner.trySetOwner(this.pendingGeneration)
    }
  }

  private enqueue(emission: PtyIngressEmission): void {
    this.queue.push(emission)
    this.queuedBytes += emission.data.length
    if (this.queuedBytes > this.maxQueuedBytes) {
      this.finishPending(this.pendingEpisode, false)
    }
  }

  private resolveIdleWaiters(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) {
      waiter()
    }
  }
}
