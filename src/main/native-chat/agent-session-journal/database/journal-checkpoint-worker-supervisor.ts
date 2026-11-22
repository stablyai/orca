import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import {
  JOURNAL_CHECKPOINT_PROGRESS,
  grantJournalTruncate,
  journalCheckpointWorkerSource,
  revokeJournalTruncate
} from './journal-checkpoint-worker-source'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'
import { JOURNAL_WAL_BACKPRESSURE_FRAMES } from './journal-wal-admission'
import {
  JournalCheckpointOutages,
  type JournalCheckpointOutage
} from './journal-checkpoint-outages'

const HEALTH_TIMEOUT_MS = 5000
const RESTART_BASE_MS = 1000
// Also how long a restarted worker must stay up before its backoff starts over.
const RESTART_MAX_MS = 60_000

export type JournalCheckpointWorkerData = {
  filename: string
  sizeLimit: number
  backpressureFrames: number
  liveness: SharedArrayBuffer
}

export type JournalCheckpointWorkerOptions = {
  factory?: (workerData: JournalCheckpointWorkerData) => WorkerRequestTransport
  timeoutMs?: number
  restartBaseMs?: number
  onOutage?: (outage: JournalCheckpointOutage) => void
  now?: () => number
}

/** What the supervisor needs from the owner of the writer's checkpoints. */
export type JournalCheckpointWorkerHost<Message> = {
  receive(message: Message): void
  lose(error: unknown, cause: JournalCheckpointOutage['cause']): void
  /** The worker is late; the owner may take checkpoints back without retiring it. */
  late(): void
  drained(): void
}

type Attached = {
  worker: WorkerRequestTransport
  liveness: Int32Array
  exited: Promise<void>
  spawnedAt: number
  /** The progress word when the deadline was armed. */
  seen: number
  /** Deadlines in a row that found it busy; a busy worker is looked at less often, up to once a minute. */
  busyDeadlines: number
  /** An idle worker silent for one deadline may just be descheduled; a second makes it dead. */
  silent: boolean
}

/** Starts, watches and restarts the checkpoint thread; at most one ever runs. */
export class JournalCheckpointWorkerSupervisor<Message> {
  private current: Attached | undefined
  private retiring: Promise<void> = Promise.resolve()
  private deadline: ReturnType<typeof setTimeout> | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private permanent = false
  private failedStarts = 0
  private restartDue = false
  /** Writes wait: a retired worker may still hold a truncate's write lock. */
  draining = false
  private readonly now: () => number
  private readonly outages: JournalCheckpointOutages

  constructor(
    private readonly filename: string,
    private readonly host: JournalCheckpointWorkerHost<Message>,
    private readonly options: JournalCheckpointWorkerOptions = {}
  ) {
    this.now = options.now ?? (() => performance.now())
    this.outages = new JournalCheckpointOutages(this.now, options.onOutage)
  }

  get running(): boolean {
    return this.current !== undefined
  }

  grantTruncate(): void {
    if (this.current) {
      grantJournalTruncate(this.current.liveness)
    }
  }

  revokeTruncate(): boolean {
    return this.current !== undefined && revokeJournalTruncate(this.current.liveness)
  }

  get watching(): boolean {
    return this.deadline !== undefined
  }

  /** No worker this launch: the writer keeps its own checkpoints. */
  disable(): void {
    this.permanent = true
  }

  start(): void {
    if (this.closed) {
      return
    }
    const liveness = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT)
    const word = new Int32Array(liveness)
    // Starting counts as busy: a thread still booting under memory pressure isn't dead.
    Atomics.store(word, JOURNAL_CHECKPOINT_PROGRESS, 1)
    const workerData: JournalCheckpointWorkerData = {
      filename: this.filename,
      sizeLimit: JOURNAL_SIZE_LIMIT_BYTES,
      backpressureFrames: JOURNAL_WAL_BACKPRESSURE_FRAMES,
      liveness
    }
    let worker: WorkerRequestTransport
    try {
      worker = this.options.factory
        ? this.options.factory(workerData)
        : spawnWorkerThread(journalCheckpointWorkerSource, {
            name: 'orca-journal-checkpoint',
            eval: true,
            workerData
          })
    } catch (error) {
      this.host.lose(error, 'spawn')
      return
    }
    const attached: Attached = {
      worker,
      liveness: word,
      spawnedAt: this.now(),
      seen: 1,
      busyDeadlines: 0,
      silent: false,
      exited: new Promise((resolve) => {
        worker.on('exit', () => {
          resolve()
          if (this.current === attached) {
            this.host.lose(new Error('checkpoint worker exited'), 'exited')
          }
        })
      })
    }
    this.current = attached
    worker.on('message', (message: Message) => {
      if (this.current === attached && !this.closed) {
        attached.busyDeadlines = 0
        attached.silent = false
        this.host.receive(message)
      }
    })
    worker.on('error', (error: Error) => {
      if (this.current === attached) {
        this.host.lose(error, 'error')
      }
    })
    worker.unref()
    // The writer keeps its checkpoints until the worker proves it is up.
    this.post({ type: 'hello' })
  }

  /** Progress is read before posting, so a reply still in flight reads as alive at the deadline. */
  post(message: unknown): void {
    const progress = this.progress()
    try {
      this.current?.worker.postMessage(message)
    } catch (error) {
      this.host.lose(error, 'error')
      return
    }
    this.watch(progress)
  }

  watch(progress = this.progress(), ms = this.options.timeoutMs ?? HEALTH_TIMEOUT_MS): void {
    this.unwatch()
    if (this.current) {
      this.current.seen = progress
    }
    this.deadline = setTimeout(() => this.expired(), ms)
    this.deadline.unref()
  }

  unwatch(): void {
    clearTimeout(this.deadline)
    this.deadline = undefined
  }

  /** The owner has taken checkpoints back; the worker is retired and replaced. */
  fail(error: unknown, cause: JournalCheckpointOutage['cause']): void {
    this.unwatch()
    this.openOutage(error, cause)
    const attached = this.current
    this.current = undefined
    if (attached) {
      // A retired worker inside a truncate holds SQLite's write lock until its thread exits.
      if (revokeJournalTruncate(attached.liveness)) {
        this.draining = true
        void attached.exited.then(() => {
          this.draining = false
          this.host.drained()
        })
      }
      this.failedStarts = this.now() - attached.spawnedAt >= RESTART_MAX_MS ? 0 : this.failedStarts
      // Terminating can't stop a native call; the next worker starts only after this one exits.
      this.retiring = attached.exited
      try {
        void attached.worker.terminate().catch((cause: unknown) => this.warn(cause))
      } catch (terminateError) {
        this.warn(terminateError)
      }
    }
    this.scheduleRestart()
  }

  /** A write waits at the WAL ceiling for a late worker: reported now, not only once it is saved. */
  /** The writer took checkpoints from a late worker: an outage until it answers, without a warning. */
  handedBack(): void {
    if (!this.permanent) {
      this.outages.begin('slow')
    }
  }

  recovered(): void {
    this.outages.end(true)
  }

  warn(error: unknown): void {
    this.outages.warn(error)
  }

  /** Stops timers and reports an open outage at once; the promise settles once the thread exits. */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.unwatch()
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
      this.outages.end(false)
    }
    return this.retire()
  }

  private async retire(): Promise<void> {
    const attached = this.current
    if (attached) {
      // Callers hand the database on after close, so it waits for the thread to exit, as main does.
      await attached.worker.terminate()
      await attached.exited
      this.current = undefined
    }
    await this.retiring
  }

  private scheduleRestart(): void {
    if (this.permanent || this.closed || this.restartTimer) {
      return
    }
    const base = this.options.restartBaseMs ?? RESTART_BASE_MS
    const delay = Math.min(base * 2 ** this.failedStarts, RESTART_MAX_MS)
    this.failedStarts++
    const retiring = this.retiring
    this.restartTimer = setTimeout(() => {
      void retiring.then(() => {
        this.restartTimer = undefined
        this.restartDue = true
      })
    }, delay)
    this.restartTimer.unref()
  }

  /** The writer committed; a replacement whose backoff has passed starts now, so an idle store spawns none. */
  wanted(): void {
    if (this.restartDue && !this.closed && !this.current) {
      this.restartDue = false
      this.outages.restarts++
      this.start()
    }
  }

  private openOutage(error: unknown, cause: JournalCheckpointOutage['cause']): void {
    if (!this.permanent) {
      this.outages.begin(cause)
    }
    this.warn(error)
  }

  private progress(): number {
    return this.current ? Atomics.load(this.current.liveness, JOURNAL_CHECKPOINT_PROGRESS) : 0
  }

  /**
   * Under paging a checkpoint's fsync can outlast the deadline, so a busy worker is never retired; only
   * a worker idle and silent for two deadlines is dead.
   */
  private expired(): void {
    this.deadline = undefined
    const attached = this.current
    if (!attached) {
      return
    }
    const progress = this.progress()
    const busy = progress % 2 === 1
    if (!busy && progress === attached.seen) {
      if (attached.silent) {
        this.host.lose(new Error('checkpoint worker response timed out'), 'unresponsive')
        return
      }
      attached.silent = true
      // Nothing moved for a deadline: a truncate it hasn't started is revoked, a late request handed back.
      this.host.late()
      this.watch(progress)
      return
    }
    attached.silent = false
    if (!busy) {
      attached.busyDeadlines = 0
      this.watch(progress)
      return
    }
    // Inside a native call it can't answer; it is kept and watched, less often the longer it stays busy.
    this.host.late()
    const timeout = this.options.timeoutMs ?? HEALTH_TIMEOUT_MS
    this.watch(progress, Math.min(timeout * 2 ** attached.busyDeadlines++, RESTART_MAX_MS))
  }
}
