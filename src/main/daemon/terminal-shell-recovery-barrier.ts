import { TerminalShellCleanExitConfirmation } from './terminal-shell-clean-exit-confirmation'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'
import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
import type { TerminalOwner } from '../../shared/terminal-owner'

// Why bounded: a pause only bridges one process proof (~100ms measured p95); a
// flood or hang means the trigger misfired, so bail out and flush unmodified.
const MAX_QUEUED_BYTES = 262_144
const MAX_PENDING_MS = 750
// Why bounded: the grounded mark is one indivisible span, and the relay never
// sends a span wider than its 16K source frame.
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

/**
 * Ordered output barrier for dead-TUI mode recovery. Sits between startup
 * ingress and the output plane. When a shell-integration command-done marker
 * (OSC 133;D) arrives while the alternate screen is still active, the stream
 * holds that marker, the execution host proves the shell owns the PTY
 * foreground, and on proof a mode reset is injected as in-stream output so
 * every downstream consumer (host emulator, mirrors, attached renderers,
 * history) converges — and the queued shell prompt then paints onto the normal
 * buffer instead of the discarded alternate screen. Holding the whole marker
 * keeps a mid-proof snapshot on an escape boundary. The reset rides on it so
 * every emission covers at least one raw unit: a zero-raw span is never sent by
 * credit-windowed delivery (SSH relay), and its seq would not rise above a
 * mid-proof snapshot, so snapshot-seq dedup would drop it. Any failure (refuted
 * proof, timeout, overflow, death, disposal) flushes the queue unmodified,
 * preserving incumbent behavior. Clean alternate-screen exits prove ownership without
 * pausing: the model needs no correction, only snapshot metadata.
 */
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

  /** Reset Terminal: grounds the lifecycle model now and returns the bytes for
   *  the host's other models. Not released downstream: a zero-raw span is dropped
   *  by credit-windowed delivery and snapshot-seq dedup, so each client grounds itself. */
  groundInputModes(): string {
    return this.scanner.groundProcessBoundary()
  }

  /** Answers a paired runtime's ownership question from the barrier's settled
   *  state. The barrier scans bytes before any consumer receives them, so its
   *  verdict is never behind the caller's parse position — a fresh process
   *  inspection here would prove nothing the barrier didn't already. */
  async confirmOwnerSettled(): Promise<boolean> {
    if (this.scanner.owner === 'shell') {
      return true
    }
    await this.awaitProofSettled()
    return this.scanner.owner === 'shell'
  }

  /** Synchronous bail for teardown: resolves the current episode as refuted so
   *  the queued bytes reach the emulator and records before a final snapshot.
   *  Queue replay can re-enter pending on a nested trigger, so drain to
   *  completion — bounded, because a pathological stream must not spin teardown. */
  flushPending(): void {
    for (let guard = 0; this.pending && guard < 16; guard += 1) {
      this.finishPending(this.pendingEpisode, false)
    }
    if (!this.pending) {
      return
    }
    // Pathological episode storm: stop rescanning but never drop bytes. The
    // scanner's model is stale from here on — a checkpoint after this may
    // publish a stale owner, acceptable only past a >16-nested-episode storm.
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

  /** Resolves when the current recovery episode (if any) has settled. Bounded
   *  by the bail timer; resolves at each episode boundary so a hostile stream
   *  of back-to-back episodes cannot starve an attach. */
  idle(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Like idle(), but also waits out an in-flight clean-exit proof so snapshot
   *  and RPC readers see a settled owner. A generation advance past the entry
   *  point ends the wait (that proof is stale), and the wait itself is bounded
   *  by the barrier's own budget — attach latency must never inherit a slow
   *  out-of-process inspection; an unsettled proof just reads as no owner. */
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
    // Callers flush first (exit, dispose, prepareForFinalSnapshot); anything
    // still queued here has no live downstream left to receive it.
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
    // end >= 1 keeps the held mark inside this emission's raw span.
    const splittable =
      end >= 1 &&
      !emission.transformed &&
      emission.rawEndSeq - emission.rawStartSeq === emission.data.length
    if (!splittable) {
      // Why skip the episode: the raw-seq boundary inside a transformed emission
      // (or a mark ending outside this one) cannot be reconstructed, so release
      // everything and keep the scanner honest about the remainder — incumbent
      // behavior for this rare corner.
      try {
        this.releaseDownstream(emission)
      } catch {
        // Why swallowed: emit already wrote and recorded before a client threw;
        // the scanner must still advance past the remainder below.
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
        // Why swallowed: the emulator and records already took the head inside
        // emit before a client's broadcast threw; aborting here would cost the
        // post-boundary prompt its entire recovery episode.
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

  /** Opens an episode holding `mark` as the queue head, already scanned. */
  private enterPending(mark: PtyIngressEmission): void {
    this.pending = true
    this.pendingEpisode += 1
    this.pendingGeneration = this.scanner.generation
    const episode = this.pendingEpisode
    this.bailTimer = setTimeout(() => this.finishPending(episode, false), this.maxPendingMs)
    this.bailTimer.unref?.()
    this.enqueue(mark)
    // Why the guard: the callback is injected; a synchronous throw must not
    // escape after pending flipped true and strand the episode until the bail.
    let proof: Promise<boolean>
    try {
      proof = this.confirmShellForeground()
    } catch {
      proof = Promise.resolve(false)
    }
    // Why the two-step then: a throw escaping finishPending must not re-enter
    // it through a catch arm as a phantom refutation.
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
          // A nested trigger inside the queue re-entered pending; requeue the rest.
          this.enqueue(queued[index]!)
          continue
        }
        try {
          this.scanAndRelease(queued[index]!)
        } catch {
          // Why swallowed: one throwing downstream client must not cost the
          // rest of the queue its delivery.
        }
      }
    } finally {
      // Why finally: an escaping throw must never orphan an attach waiting in
      // settleShellOwnershipConfirmation — that wedges createOrAttach forever.
      this.resolveIdleWaiters()
    }
  }

  private releaseMark(mark: PtyIngressEmission, grounded: boolean): void {
    try {
      this.releaseDownstream(
        grounded
          ? {
              ...mark,
              // Scanned before release so alt-state stays honest.
              data: mark.data + this.scanner.groundProcessBoundary(),
              transformed: true
            }
          : mark
      )
    } catch {
      // Why swallowed: a throwing downstream client must not strand the
      // queued prompt bytes behind it.
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
