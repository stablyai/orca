import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { estimateZotzAgentMemory } from '../../../shared/zotz/agent-queue/zotz-agent-memory-ledger'
import {
  createZotzAgentQueue,
  enqueueZotzAgentTask,
  orderZotzAgentQueue,
  removeZotzAgentTask,
  type ZotzAgentQueue,
  type ZotzAgentTaskPriority,
  type ZotzQueuedAgentTask
} from '../../../shared/zotz/agent-queue/zotz-agent-queue'
import {
  scheduleNextZotzAgentTask,
  zotzAgentTaskWaitReason,
  type ZotzAgentCapacity,
  type ZotzAgentWaitReason
} from '../../../shared/zotz/agent-queue/zotz-agent-queue-scheduler'
import type { ZotzMemoryGovernorService } from './zotz-memory-governor-service'

export type ZotzAgentLaunchRequest = {
  agent: TuiAgent
  priority: ZotzAgentTaskPriority
  /** The pane the agent opens in; a remount's second spawn joins the same entry. */
  paneKey: string | null
  label: string
  signal?: AbortSignal
}

export type ZotzQueuedLaunchView = ZotzQueuedAgentTask & {
  position: number
  waitReason: ZotzAgentWaitReason | 'pressure' | null
}

/** A canceled launch still opens its pane, as a plain shell, so the pane never retries it. */
export type ZotzAdmission = 'admitted' | 'canceled'

export type ZotzCanceledLaunch = { id: string; agent: TuiAgent; label: string; canceledAt: number }

type Waiter = {
  promise: Promise<ZotzAdmission>
  resolve: (admission: ZotzAdmission) => void
  agent: TuiAgent
  label: string
}

/** Holds the part of an admitted agent's estimate its measurement has not reached yet, until it times out. */
type Reservation = { id: string; agent: TuiAgent; bytes: number; until: number }

// A started agent shows up in the memory sample within a few samples; until then its estimate holds its place.
const RESERVATION_MS = 90_000
// The governor stops sampling when idle; an older sample says nothing about memory now.
const FRESH_SAMPLE_MS = 20_000

// Enough to cover every pane still open; older marks belong to long-closed tabs.
const CANCELED_KEPT = 50

/**
 * Holds agent launches until memory and the concurrency limit allow them, in the order of
 * docs/zotz/PLAN.md §8 (multilevel FIFO with backfill and aging). Lives only in memory.
 */
export class ZotzAgentLaunchQueue {
  private queue: ZotzAgentQueue = createZotzAgentQueue()
  private readonly waiters = new Map<string, Waiter>()
  private reservations: Reservation[] = []
  private canceled: ZotzCanceledLaunch[] = []
  private readonly listeners = new Set<() => void>()
  private enabled = true

  constructor(
    private readonly governor: Pick<
      ZotzMemoryGovernorService,
      'setWaitingDemand' | 'subscribe' | 'getState' | 'getLedger' | 'wake'
    >,
    private readonly now: () => number = Date.now
  ) {
    governor.setWaitingDemand(() => this.queue.tasks.length > 0)
    governor.subscribe(() => this.schedule())
  }

  /** Turning the queue off starts everything waiting and stops holding new launches. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      for (const task of orderZotzAgentQueue(this.queue)) {
        this.release(task.id)
      }
    }
  }

  /** Resolves when the launch may start, or with 'canceled' once the user canceled that pane. */
  admit(request: ZotzAgentLaunchRequest): Promise<ZotzAdmission> {
    if (!this.enabled) {
      return Promise.resolve('admitted')
    }
    const id = request.paneKey ?? randomUUID()
    // The pane respawns after a cancel; it stays canceled until the user dismisses the mark.
    if (this.canceled.some((entry) => entry.id === id)) {
      return Promise.resolve('canceled')
    }
    const existing = this.waiters.get(id)
    if (existing) {
      return existing.promise
    }
    let resolve!: (admission: ZotzAdmission) => void
    const promise = new Promise<ZotzAdmission>((res) => {
      resolve = res
    })
    this.waiters.set(id, { promise, resolve, agent: request.agent, label: request.label })
    const limits = this.governor.getState()?.limits
    this.queue = enqueueZotzAgentTask(
      this.queue,
      {
        id,
        agent: request.agent,
        priority: request.priority,
        estimatedBytes: estimateZotzAgentMemory(
          this.governor.getLedger(),
          request.agent,
          limits?.agentDefaultReserveBytes ?? 2.5 * 1024 ** 3
        ),
        label: request.label,
        launch: null
      },
      this.now()
    )
    // A closed pane is gone, not canceled: nothing to mark.
    request.signal?.addEventListener('abort', () => this.withdraw(id, false), { once: true })
    this.schedule()
    this.governor.wake()
    return promise
  }

  /** "Launch anyway": starts the task now whatever the memory says. */
  forceStart(id: string): void {
    this.release(id)
  }

  /** The user's Cancel: the pane opens as a plain shell and keeps a "canceled" mark. */
  cancel(id: string): void {
    this.withdraw(id, true)
  }

  private withdraw(id: string, markCanceled: boolean): void {
    const waiter = this.waiters.get(id)
    if (!waiter) {
      return
    }
    this.waiters.delete(id)
    this.queue = removeZotzAgentTask(this.queue, id)
    if (markCanceled) {
      this.canceled = [
        { id, agent: waiter.agent, label: waiter.label, canceledAt: this.now() },
        ...this.canceled
      ].slice(0, CANCELED_KEPT)
    }
    waiter.resolve('canceled')
    this.notify()
  }

  /** Canceled launches, newest first; their panes show the mark until it is dismissed. */
  listCanceled(): readonly ZotzCanceledLaunch[] {
    return this.canceled
  }

  dismissCanceled(id: string): void {
    const before = this.canceled.length
    this.canceled = this.canceled.filter((entry) => entry.id !== id)
    if (this.canceled.length !== before) {
      this.notify()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The backlog in service order, with why each task is still waiting. */
  list(): ZotzQueuedLaunchView[] {
    const capacity = this.capacity()
    const pressure = this.governor.getState()?.pressure ?? 'ok'
    return orderZotzAgentQueue(this.queue).map((task, index) => ({
      ...task,
      position: index + 1,
      waitReason:
        pressure !== 'ok' ? 'pressure' : capacity ? zotzAgentTaskWaitReason(task, capacity) : null
    }))
  }

  private release(id: string): void {
    const task = this.queue.tasks.find((entry) => entry.id === id)
    const waiter = this.waiters.get(id)
    if (!task || !waiter) {
      return
    }
    this.queue = removeZotzAgentTask(this.queue, id)
    this.waiters.delete(id)
    this.reservations.push({
      id,
      agent: task.agent,
      bytes: task.estimatedBytes,
      until: this.now() + RESERVATION_MS
    })
    waiter.resolve('admitted')
    this.notify()
  }

  private capacity(): ZotzAgentCapacity | null {
    const state = this.governor.getState()
    const now = this.now()
    if (!state || now - state.sampledAt > FRESH_SAMPLE_MS) {
      return null
    }
    this.reservations = this.reservations.filter((reservation) => reservation.until > now)
    // A just-started agent is measured small at first; hold the rest of its estimate until it grows.
    const measured = new Map(state.agents.map((agent) => [agent.paneKey, agent.bytes]))
    const pendingBytes = this.reservations.reduce(
      (sum, reservation) =>
        sum + Math.max(0, reservation.bytes - (measured.get(reservation.id) ?? 0)),
      0
    )
    return {
      availableBytes: state.availableBytes - pendingBytes,
      minFreeBytes: state.limits.minFreeBytes
    }
  }

  private schedule(): void {
    for (;;) {
      const capacity = this.capacity()
      // Without a first sample, or with the machine under pressure, nothing new starts.
      if (!capacity || this.governor.getState()?.pressure !== 'ok') {
        break
      }
      const { decision, queue } = scheduleNextZotzAgentTask(this.queue, capacity, this.now())
      if (decision.kind !== 'admit') {
        this.queue = queue
        break
      }
      // Keep the bypass count the scheduler recorded, then hand the task to its waiter.
      this.queue = { ...queue, tasks: [...queue.tasks, decision.task] }
      this.release(decision.task.id)
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
