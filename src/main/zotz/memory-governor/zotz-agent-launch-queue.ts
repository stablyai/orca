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

type Waiter = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

type Reservation = { agent: TuiAgent; bytes: number; until: number }

// A started agent shows up in the memory sample within a few samples; until then its estimate holds its place.
const RESERVATION_MS = 90_000
// The governor stops sampling when idle; an older sample says nothing about memory now.
const FRESH_SAMPLE_MS = 20_000

export class ZotzAgentLaunchCanceledError extends Error {
  constructor() {
    super('The queued agent launch was canceled.')
    this.name = 'ZotzAgentLaunchCanceledError'
  }
}

/**
 * Holds agent launches until memory and the concurrency limit allow them, in the order of
 * docs/zotz/PLAN.md §8 (multilevel FIFO with backfill and aging). Lives only in memory.
 */
export class ZotzAgentLaunchQueue {
  private queue: ZotzAgentQueue = createZotzAgentQueue()
  private readonly waiters = new Map<string, Waiter>()
  private reservations: Reservation[] = []
  private readonly listeners = new Set<() => void>()

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

  /** Resolves when the launch may start; rejects if it is canceled while waiting. */
  admit(request: ZotzAgentLaunchRequest): Promise<void> {
    const id = request.paneKey ?? randomUUID()
    const existing = this.waiters.get(id)
    if (existing) {
      return existing.promise
    }
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.waiters.set(id, { promise, resolve, reject })
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
    request.signal?.addEventListener('abort', () => this.cancel(id), { once: true })
    this.schedule()
    this.governor.wake()
    return promise
  }

  /** "Launch anyway": starts the task now whatever the memory says. */
  forceStart(id: string): void {
    this.release(id)
  }

  cancel(id: string): void {
    const waiter = this.waiters.get(id)
    if (!waiter) {
      return
    }
    this.waiters.delete(id)
    this.queue = removeZotzAgentTask(this.queue, id)
    waiter.reject(new ZotzAgentLaunchCanceledError())
    this.notify()
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
      agent: task.agent,
      bytes: task.estimatedBytes,
      until: this.now() + RESERVATION_MS
    })
    waiter.resolve()
    this.notify()
  }

  private capacity(): ZotzAgentCapacity | null {
    const state = this.governor.getState()
    const now = this.now()
    if (!state || now - state.sampledAt > FRESH_SAMPLE_MS) {
      return null
    }
    this.reservations = this.reservations.filter((reservation) => reservation.until > now)
    const reservedBytes = this.reservations.reduce((sum, reservation) => sum + reservation.bytes, 0)
    const measuredBytes = state.agents.reduce((sum, agent) => sum + agent.bytes, 0)
    return {
      availableBytes: state.availableBytes - reservedBytes,
      minFreeBytes: state.limits.minFreeBytes,
      agentBudgetBytes: state.limits.agentBudgetBytes,
      committedAgentBytes: measuredBytes + reservedBytes,
      liveAgents: state.agents.length + this.reservations.length,
      maxConcurrentAgents: state.limits.maxConcurrentAgents
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
