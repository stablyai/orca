import { ProducerRevision } from '../sidebar-inputs/producer-revision'
import type {
  WorkspaceLifecycleHint,
  WorkspaceLifecycleKind
} from '../../../shared/sidebar-list/workspace-lifecycle-hints'
import type { WorkspaceCreationsSnapshot } from '../../../shared/sidebar-list/workspace-creations'
import {
  WORKSPACE_DELETED_ERROR,
  attemptLifecycleCommand,
  type LifecycleAttempt,
  type LifecycleCommand,
  type LifecycleMembership
} from './workspace-lifecycle-command'
import {
  WorkspaceLifecycleCreations,
  type WorkspaceCreationHandle
} from './workspace-lifecycle-creations'

type Entry = {
  kind: WorkspaceLifecycleKind
  /** Arrival order across every workspace, so a command waiting on its lookup keeps its place. */
  seq: number
  state: 'queued' | 'running'
  /** Null for a create, which runs outside the queue between open and close. */
  command: LifecycleCommand<unknown> | null
  reply: Promise<unknown> | null
  settle: (attempt: LifecycleAttempt) => void
}

type Pause = { kind: WorkspaceLifecycleKind; observe: (() => Promise<void>) | null }

type WorkspaceQueue = {
  entries: Entry[]
  paused: Pause | null
  /** A finished create or delete, held until a fresh listing shows its membership. */
  settling: number
  draining: boolean
  /** Ends a wait on the pause early: a forced delete arrived. */
  wake: (() => void) | null
}

type Signal = { promise: Promise<void>; notify: () => void }

const OBSERVE_RETRY_MS = 5_000
// Long enough for a lookup on a reachable host, so its command keeps its place in the order.
const LOOKUP_ORDER_WAIT_MS = 500

function signal(): Signal {
  let notify!: () => void
  const promise = new Promise<void>((resolve) => (notify = resolve))
  return { promise, notify }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

/**
 * One FIFO queue per host-qualified workspace for create, sleep, wake, close and delete. Commands
 * run one at a time in the order they arrived and are never merged. Delete cancels what has not
 * started and waits for what has. An unconfirmed outcome pauses the queue until the owner answers
 * again; main then re-observes and carries on, never replaying the paused command. Lives in
 * memory: after a restart nothing is pending and readers show observed state.
 */
export class WorkspaceLifecycleQueue {
  readonly revision = new ProducerRevision()
  private readonly queues = new Map<string, WorkspaceQueue>()
  private membership: LifecycleMembership = (done) => done()
  private nextSeq = 0
  /**
   * Arrivals still looking up their workspace, by when they arrived. A later arrival waits for
   * them only briefly: the lookup may name any workspace, and a dead host must not stall them all.
   */
  private readonly resolving = new Map<number, number>()
  private resolved: Signal = signal()
  private readonly creations = new WorkspaceLifecycleCreations<Entry>({
    revision: this.revision,
    membership: () => this.membership,
    deletePending: (key) => this.deletePending(key),
    bind: (key) => this.bindCreate(key),
    finish: (key, entry) => this.finishEntry(key, entry)
  })

  constructor(
    private readonly retryDelay: (ms: number) => Promise<void> = sleep,
    private readonly now: () => number = Date.now
  ) {}

  /** How long `seq` still waits for an earlier arrival's lookup; 0 once none holds it. */
  private lookupWaitMs(seq: number): number {
    const waits = [...this.resolving].flatMap(([earlier, arrivedAt]) =>
      earlier < seq ? [arrivedAt + LOOKUP_ORDER_WAIT_MS - this.now()] : []
    )
    return Math.max(0, ...waits)
  }

  /** Where finished creates and deletes wait to be listed; until set they settle at once. */
  setMembership(membership: LifecycleMembership): void {
    this.membership = membership
  }

  submit<T>(key: string, command: LifecycleCommand<T>): Promise<T> {
    return this.enqueue(key, command, this.nextSeq++)
  }

  /**
   * For a command whose workspace is known only after a lookup: it takes its place on arrival.
   * A lookup answering null finds no workspace to order against, so the command runs directly.
   */
  async submitResolving<T>(
    resolveKey: () => Promise<string | null>,
    command: LifecycleCommand<T>
  ): Promise<T> {
    const seq = this.nextSeq++
    this.resolving.set(seq, this.now())
    let key: string | null
    try {
      key = await resolveKey()
    } finally {
      this.resolving.delete(seq)
      const resolved = this.resolved
      this.resolved = signal()
      resolved.notify()
    }
    return key === null ? command.run() : this.enqueue(key, command, seq)
  }

  openCreate(
    start: Parameters<WorkspaceLifecycleCreations<Entry>['open']>[0]
  ): WorkspaceCreationHandle {
    return this.creations.open(start)
  }

  /** The per-workspace hints the feed publishes. */
  hints(): Record<string, WorkspaceLifecycleHint> {
    const hints: Record<string, WorkspaceLifecycleHint> = {}
    for (const [key, queue] of this.queues) {
      const deleting = queue.entries.some((entry) => entry.kind === 'delete')
      const head = queue.entries[0]
      const kind = deleting ? 'delete' : (head?.kind ?? queue.paused?.kind)
      if (kind === undefined) {
        // Only a settling delete is left: it shows until its row leaves the listing.
        if (queue.settling > 0) {
          hints[key] = { kind: 'delete', queuedBehind: 0 }
        }
        continue
      }
      hints[key] = {
        kind,
        queuedBehind: deleting ? 0 : Math.max(0, queue.entries.length - 1),
        ...(queue.paused ? { paused: true as const } : {})
      }
    }
    for (const key of this.creations.settlingKeys()) {
      hints[key] ??= { kind: 'create', queuedBehind: 0 }
    }
    return hints
  }

  /** The creations projection the `creations` readers already read. */
  creationsSnapshot(): WorkspaceCreationsSnapshot {
    return this.creations.snapshot()
  }

  /** Host-qualified keys whose last command went unconfirmed by its host. */
  pausedKeys(): string[] {
    return [...this.queues].flatMap(([key, queue]) => (queue.paused ? [key] : []))
  }

  private enqueue<T>(key: string, command: LifecycleCommand<T>, seq: number): Promise<T> {
    const queue = this.queueFor(key)
    const pendingDelete = queue.entries.find((entry) => entry.kind === 'delete')
    if (pendingDelete) {
      const pending = pendingDelete.command?.delete
      if (command.kind !== 'delete') {
        return Promise.reject(new Error(WORKSPACE_DELETED_ERROR))
      }
      if (pendingDelete.reply && pending?.key === command.delete?.key) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an equal delete shares the pending delete's reply, as a removal in flight always has.
        return pendingDelete.reply as Promise<T>
      }
      // A forced delete replaces an unforced one still waiting (behind a pause); never a running one.
      if (!command.delete?.force || pendingDelete.state === 'running') {
        const label = command.delete?.label ?? key
        return Promise.reject(new Error(`Worktree deletion already in progress: ${label}`))
      }
    }
    if (command.kind === 'delete') {
      this.cancelQueued(queue)
    }
    let settle!: (attempt: LifecycleAttempt) => void
    const reply = new Promise<unknown>((resolve, reject) => {
      settle = (result) => (result.threw ? reject(result.error) : resolve(result.value))
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widened only to be stored; run's result is handed back to this command's own caller.
    const stored = command as LifecycleCommand<unknown>
    const entry: Entry = {
      kind: command.kind,
      seq,
      state: 'queued',
      command: stored,
      reply,
      settle
    }
    // In arrival order among what has not started; a late lookup goes ahead of later arrivals.
    const after = queue.entries.findIndex((queued) => queued.state === 'queued' && queued.seq > seq)
    queue.entries.splice(after === -1 ? queue.entries.length : after, 0, entry)
    this.revision.bump()
    if (command.delete?.force) {
      queue.wake?.()
    }
    void this.drain(key)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settled only with this command's run result.
    return reply as Promise<T>
  }

  private deletePending(key: string): boolean {
    return this.queues.get(key)?.entries.some((entry) => entry.kind === 'delete') === true
  }

  private queueFor(key: string): WorkspaceQueue {
    let queue = this.queues.get(key)
    if (!queue) {
      queue = { entries: [], paused: null, settling: 0, draining: false, wake: null }
      this.queues.set(key, queue)
    }
    return queue
  }

  private bindCreate(key: string): Entry {
    const queue = this.queueFor(key)
    const entry: Entry = {
      kind: 'create',
      seq: this.nextSeq++,
      state: 'running',
      command: null,
      reply: null,
      settle: () => {}
    }
    // Ahead of everything not started: the create is already running.
    const firstQueued = queue.entries.findIndex((queued) => queued.state === 'queued')
    queue.entries.splice(firstQueued === -1 ? queue.entries.length : firstQueued, 0, entry)
    return entry
  }

  private finishEntry(key: string, entry: Entry): void {
    const queue = this.queues.get(key)
    const index = queue?.entries.indexOf(entry) ?? -1
    if (queue && index !== -1) {
      queue.entries.splice(index, 1)
      this.revision.bump()
      void this.drain(key)
    }
  }

  private cancelQueued(queue: WorkspaceQueue): void {
    const cancelled = queue.entries.filter((entry) => entry.state === 'queued')
    queue.entries = queue.entries.filter((entry) => entry.state !== 'queued')
    for (const entry of cancelled) {
      entry.settle({ outcome: 'settled', error: new Error(WORKSPACE_DELETED_ERROR), threw: true })
    }
  }

  private async drain(key: string): Promise<void> {
    const queue = this.queues.get(key)
    if (!queue || queue.draining) {
      return
    }
    queue.draining = true
    try {
      for (let head = queue.entries[0]; head; head = queue.entries[0]) {
        if (head.state === 'running' || !head.command) {
          // A create running outside the queue; its close drains again.
          return
        }
        const waitMs = this.lookupWaitMs(head.seq)
        if (waitMs > 0) {
          await Promise.race([this.resolved.promise, this.retryDelay(waitMs)])
          continue
        }
        if (queue.paused && !head.command.delete?.force) {
          await this.awaitOwner(queue, queue.paused)
          continue
        }
        await this.runHead(key, queue, head, head.command)
      }
    } finally {
      queue.draining = false
      this.forgetIfIdle(key, queue)
    }
  }

  private async runHead(
    key: string,
    queue: WorkspaceQueue,
    head: Entry,
    command: LifecycleCommand<unknown>
  ): Promise<void> {
    head.state = 'running'
    this.revision.bump()
    const result = await attemptLifecycleCommand(command)
    queue.entries.splice(queue.entries.indexOf(head), 1)
    if (result.outcome === 'unverifiable') {
      queue.paused = { kind: head.kind, observe: command.observe ?? null }
    } else if (head.kind === 'delete' && !result.threw) {
      // Deleted: nothing is left to observe.
      queue.paused = null
      queue.settling += 1
      this.membership(() => {
        queue.settling -= 1
        this.revision.bump()
        this.forgetIfIdle(key, queue)
      })
    }
    head.settle(result)
    this.revision.bump()
  }

  /**
   * Waits for the paused command's owner to answer again, then re-observes the listing and lifts
   * the pause. Returns early when a forced delete arrives; a silent owner is asked again later.
   */
  private async awaitOwner(queue: WorkspaceQueue, paused: Pause): Promise<void> {
    if (!paused.observe) {
      queue.paused = null
      this.revision.bump()
      return
    }
    const woken = new Promise<'woken'>((resolve) => (queue.wake = () => resolve('woken')))
    try {
      const answered = await Promise.race([
        paused.observe().then(
          () => true,
          () => false
        ),
        woken
      ])
      if (answered === true) {
        await new Promise<void>((done) => this.membership(done))
        if (queue.paused === paused) {
          queue.paused = null
          this.revision.bump()
        }
      } else if (answered === false) {
        await Promise.race([this.retryDelay(OBSERVE_RETRY_MS), woken])
      }
    } finally {
      queue.wake = null
    }
  }

  private forgetIfIdle(key: string, queue: WorkspaceQueue): void {
    if (
      queue.entries.length === 0 &&
      !queue.paused &&
      queue.settling === 0 &&
      !queue.draining &&
      this.queues.get(key) === queue
    ) {
      this.queues.delete(key)
    }
  }
}
