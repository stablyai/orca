import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import {
  JOURNAL_CHECKPOINT_PROGRESS,
  journalCheckpointWorkerSource
} from './journal-checkpoint-worker-source'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'
import { JOURNAL_WAL_BACKPRESSURE_FRAMES } from './journal-wal-admission'
import {
  JournalCheckpointOutages,
  type JournalCheckpointOutage
} from './journal-checkpoint-outages'

const HEALTH_TIMEOUT_MS = 5000
// A busy worker past this many ms without a reply is treated as stuck in a native call: the writer
// takes checkpoints back, and the worker is kept (terminating can't interrupt that call).
const STUCK_MS = 60_000
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
  stuckMs?: number
  restartBaseMs?: number
  onOutage?: (outage: JournalCheckpointOutage) => void
  now?: () => number
}

/** What the supervisor needs from the owner of the writer's checkpoints. */
export type JournalCheckpointWorkerHost<Message> = {
  receive(message: Message): void
  lose(error: unknown, cause: JournalCheckpointOutage['cause']): void
  /** Whether a worker stuck past STUCK_MS hands checkpoints back; false while it holds a truncate. */
  releasesStuck(): boolean
}

type Attached = {
  worker: WorkerRequestTransport
  liveness: Int32Array
  exited: Promise<void>
  spawnedAt: number
  /** The progress word when the deadline was armed. */
  seen: number
  busySince: number | undefined
  stuck: boolean
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
  private warned = false
  private failedStarts = 0
  private readonly now: () => number
  private readonly outages: JournalCheckpointOutages

  constructor(
    private readonly filename: string,
    private readonly host: JournalCheckpointWorkerHost<Message>,
    private readonly options: JournalCheckpointWorkerOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.outages = new JournalCheckpointOutages(this.now, options.onOutage)
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
    const liveness = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
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
      busySince: undefined,
      stuck: false,
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
        attached.busySince = undefined
        attached.silent = false
        attached.stuck = false
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

  watch(progress = this.progress()): void {
    this.unwatch()
    if (this.current) {
      this.current.seen = progress
    }
    this.deadline = setTimeout(() => this.expired(), this.options.timeoutMs ?? HEALTH_TIMEOUT_MS)
    this.deadline.unref()
  }

  unwatch(): void {
    clearTimeout(this.deadline)
    this.deadline = undefined
  }

  /** The owner has taken checkpoints back; a stuck worker is kept, any other is replaced. */
  fail(error: unknown, cause: JournalCheckpointOutage['cause']): void {
    this.unwatch()
    this.openOutage(error, cause)
    if (cause === 'slow') {
      this.watch()
      return
    }
    const attached = this.current
    this.current = undefined
    if (attached) {
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

  recovered(): void {
    if (this.outages.end(true)) {
      this.warned = false
    }
  }

  warn(error: unknown): void {
    if (this.warned) {
      return
    }
    this.warned = true
    try {
      console.warn(
        '[agent-session-journal] checkpoint worker unavailable; writer checkpoints',
        error
      )
    } catch {
      // A diagnostic must never turn a committed write into an apparent failure.
    }
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
        if (!this.closed && !this.current) {
          this.outages.restarts++
          this.start()
        }
      })
    }, delay)
    this.restartTimer.unref()
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
   * Under paging a checkpoint's fsync can outlast the deadline, so a busy worker keeps its checkpoints
   * until it is stuck past STUCK_MS; only a worker idle and silent for two deadlines is dead.
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
      this.watch(progress)
      return
    }
    attached.silent = false
    if (busy) {
      const now = this.now()
      attached.busySince ??= now
      if (!attached.stuck && now - attached.busySince >= (this.options.stuckMs ?? STUCK_MS)) {
        attached.stuck = true
        const error = new Error('checkpoint worker is stuck in a checkpoint')
        if (this.host.releasesStuck()) {
          this.host.lose(error, 'slow')
          return
        }
        this.openOutage(error, 'slow')
      }
    }
    this.watch(progress)
  }
}
