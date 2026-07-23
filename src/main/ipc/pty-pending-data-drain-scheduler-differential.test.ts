import { describe, expect, it } from 'vitest'
import {
  PtyPendingDataDrainQueue,
  type PendingPtyData,
  type PtyPendingDataDrainSelection
} from './pty-pending-data-drain-queue'

const CHUNK_CHARS = 4
const MAX_WRITES = 2
const PER_PTY_LIMIT = 8
const TOTAL_LIMIT = 12
const ACTIVE_PER_PTY_RESERVE = 4
const ACTIVE_TOTAL_RESERVE = 4

type EngineKind = 'legacy' | 'queue'
type Accounting = { sent: number; acked: number }
type DeliveryEvent =
  | {
      kind: 'data'
      id: string
      data: string
      rawLength: number
      transformed?: true
      droppedOutput?: true
    }
  | { kind: 'exit'; id: string }
  | { kind: 'ack'; id: string; processedChars: number; creditedChars: number }
  | { kind: 'tick'; delayMs: number }
  | { kind: 'drop'; id: string; data: string }
  | { kind: 'clear' }

type Candidate = {
  id: string
  pending: PendingPtyData
  block(): void
  remove(): void
  replace(pending: PendingPtyData): void
}

type EngineSnapshot = {
  pending: [string, PendingPtyData][]
  accounting: [string, Accounting][]
  totalInFlight: number
  flowPending: [string, number][]
  scheduledDelay: number | null
  timerArmCount: number
  events: DeliveryEvent[]
}

class DrainSchedulerEngine {
  private readonly legacyPending = new Map<string, PendingPtyData>()
  private readonly queue: PtyPendingDataDrainQueue | null
  private readonly active = new Set<string>()
  private readonly droppable = new Set<string>()
  private readonly accounting = new Map<string, Accounting>()
  private readonly flowPending = new Map<string, number>()
  private readonly exiting = new Set<string>()
  private totalInFlight = 0
  private scheduledDelay: number | null = null
  private timerArmCount = 0
  private clearGeneration = 0
  private draining = false
  private creditReleasedWhileDraining = false
  private notify: ((event: DeliveryEvent) => void) | null = null
  readonly events: DeliveryEvent[] = []
  legacySnapshotEntryVisits = 0

  constructor(private readonly kind: EngineKind) {
    this.queue =
      kind === 'queue'
        ? new PtyPendingDataDrainQueue((id) => {
            if (this.droppable.has(id)) {
              return this.active.has(id) ? 'active' : 'background'
            }
            if (!this.canSend(id)) {
              return 'blocked'
            }
            return this.active.has(id) ? 'active' : 'background'
          })
        : null
  }

  enqueue(id: string, pending: PendingPtyData): void {
    this.setPending(id, { ...pending })
    this.flowPending.set(id, pending.data.length)
    this.schedule(2)
  }

  setActive(id: string, active: boolean): void {
    const changed = active ? !this.active.has(id) : this.active.has(id)
    if (!changed) {
      return
    }
    if (active) {
      this.active.add(id)
    } else {
      this.active.delete(id)
    }
    if (this.getPending(id)) {
      this.queue?.invalidateAll()
      this.schedule(0)
    }
  }

  setDroppable(id: string, droppable: boolean): void {
    const changed = droppable ? !this.droppable.has(id) : this.droppable.has(id)
    if (!changed) {
      return
    }
    if (droppable) {
      this.droppable.add(id)
    } else {
      this.droppable.delete(id)
    }
    if (this.getPending(id)) {
      this.queue?.invalidateAll()
      this.schedule(0)
    }
  }

  acknowledge(id: string, processedChars: number): number {
    const creditedChars = this.applyCumulativeAck(id, Math.max(0, processedChars))
    this.events.push({ kind: 'ack', id, processedChars, creditedChars })
    if (creditedChars > 0) {
      this.queue?.reactivateBlocked()
    }
    if (this.pendingSize > 0) {
      this.schedule(0)
    }
    return creditedChars
  }

  tick(): void {
    const delayMs = this.scheduledDelay
    if (delayMs === null) {
      throw new Error('No pending drain timer')
    }
    this.scheduledDelay = null
    this.events.push({ kind: 'tick', delayMs })
    const generation = this.clearGeneration
    let writes = 0
    this.draining = true
    this.creditReleasedWhileDraining = false

    if (this.queue) {
      const round = this.queue.beginRound()
      try {
        while (writes < MAX_WRITES) {
          const selection = this.queue.takeNext(round)
          if (!selection) {
            break
          }
          writes += this.processCandidate(this.queueCandidate(selection))
          if (generation !== this.clearGeneration) {
            break
          }
        }
      } finally {
        this.queue.endRound(round)
      }
    } else {
      const entries = [...this.legacyPending.entries()]
      const ordered = [
        ...entries.filter(([id]) => this.active.has(id)),
        ...entries.filter(([id]) => !this.active.has(id))
      ]
      this.legacySnapshotEntryVisits += entries.length
      for (const [id, pending] of ordered) {
        if (writes >= MAX_WRITES || generation !== this.clearGeneration) {
          break
        }
        if (!this.legacyPending.has(id)) {
          continue
        }
        writes += this.processCandidate(this.legacyCandidate(id, pending))
      }
    }
    this.draining = false
    const creditReleasedWhileDraining = this.creditReleasedWhileDraining
    this.creditReleasedWhileDraining = false

    if (this.pendingSize > 0 && (writes > 0 || creditReleasedWhileDraining)) {
      this.schedule(writes > 0 ? 1 : 0)
    }
  }

  exit(id: string): void {
    if (this.exiting.has(id)) {
      return
    }
    this.exiting.add(id)
    try {
      const hadReleasableCredit = this.inFlightFor(id) > 0
      const remaining = this.deletePending(id)
      if (this.pendingSize === 0) {
        this.scheduledDelay = null
      }
      this.flowPending.delete(id)
      if (remaining) {
        this.sendFinal(id, remaining)
      }
      const releasedChars = this.inFlightFor(id)
      this.totalInFlight = Math.max(0, this.totalInFlight - releasedChars)
      this.accounting.delete(id)
      if (hadReleasableCredit && this.kind === 'queue') {
        const reactivatedBlocked = this.queue?.reactivateBlocked() === true
        if (this.draining) {
          this.creditReleasedWhileDraining ||= reactivatedBlocked
        } else if (this.pendingSize > 0) {
          this.schedule(0)
        }
      }
      this.events.push({ kind: 'exit', id })
    } finally {
      this.exiting.delete(id)
    }
  }

  clear(): void {
    this.clearGeneration += 1
    if (this.queue) {
      this.queue.clear()
    } else {
      this.legacyPending.clear()
    }
    this.flowPending.clear()
    this.accounting.clear()
    this.totalInFlight = 0
    this.events.push({ kind: 'clear' })
  }

  setNotification(callback: ((event: DeliveryEvent) => void) | null): void {
    this.notify = callback
  }

  snapshot(): EngineSnapshot {
    return {
      pending: this.pendingEntries().map(([id, pending]) => [id, { ...pending }]),
      accounting: Array.from(this.accounting, ([id, value]) => [id, { ...value }]),
      totalInFlight: this.totalInFlight,
      flowPending: [...this.flowPending.entries()],
      scheduledDelay: this.scheduledDelay,
      timerArmCount: this.timerArmCount,
      events: this.events.map((event) => ({ ...event }))
    }
  }

  debugQueue(): ReturnType<PtyPendingDataDrainQueue['getDebugSnapshot']> {
    if (!this.queue) {
      throw new Error('Legacy engine has no queue debug state')
    }
    return this.queue.getDebugSnapshot()
  }

  private get pendingSize(): number {
    return this.queue?.size ?? this.legacyPending.size
  }

  private pendingEntries(): [string, PendingPtyData][] {
    if (!this.queue) {
      return [...this.legacyPending.entries()]
    }
    return [...this.queue.keys()].map((id) => [id, this.queue!.get(id)!])
  }

  private getPending(id: string): PendingPtyData | undefined {
    return this.queue?.get(id) ?? this.legacyPending.get(id)
  }

  private setPending(id: string, pending: PendingPtyData): void {
    if (this.queue) {
      this.queue.set(id, pending)
    } else {
      this.legacyPending.set(id, pending)
    }
  }

  private deletePending(id: string): PendingPtyData | undefined {
    if (this.queue) {
      return this.queue.delete(id)
    }
    const pending = this.legacyPending.get(id)
    this.legacyPending.delete(id)
    return pending
  }

  private schedule(delayMs: number): void {
    if (this.scheduledDelay !== null) {
      return
    }
    this.scheduledDelay = delayMs
    this.timerArmCount += 1
  }

  private inFlightFor(id: string): number {
    const accounting = this.accounting.get(id)
    return accounting ? accounting.sent - accounting.acked : 0
  }

  private canSend(id: string): boolean {
    const active = this.active.has(id)
    const perPtyLimit = PER_PTY_LIMIT + (active ? ACTIVE_PER_PTY_RESERVE : 0)
    const totalLimit = TOTAL_LIMIT + (active ? ACTIVE_TOTAL_RESERVE : 0)
    return this.inFlightFor(id) < perPtyLimit && this.totalInFlight < totalLimit
  }

  private applyCumulativeAck(id: string, processedChars: number): number {
    const accounting = this.accounting.get(id)
    if (!accounting) {
      return 0
    }
    const nextAcked = Math.min(accounting.sent, Math.max(accounting.acked, processedChars))
    const credited = nextAcked - accounting.acked
    accounting.acked = nextAcked
    this.totalInFlight = Math.max(0, this.totalInFlight - credited)
    return credited
  }

  private recordSend(id: string, rawLength: number): void {
    const accounting = this.accounting.get(id)
    if (accounting) {
      accounting.sent += rawLength
    } else {
      this.accounting.set(id, { sent: rawLength, acked: 0 })
    }
    this.totalInFlight += rawLength
  }

  private sendFinal(id: string, pending: PendingPtyData): void {
    const rawLength = pending.rawLength ?? pending.data.length
    this.recordSend(id, rawLength)
    const event: DeliveryEvent = {
      kind: 'data',
      id,
      data: pending.data,
      rawLength,
      ...(pending.transformed === true ? { transformed: true } : {}),
      ...(pending.droppedOutput === true ? { droppedOutput: true } : {})
    }
    this.events.push(event)
    this.notify?.(event)
  }

  private processCandidate(candidate: Candidate): number {
    const { id, pending } = candidate
    if (this.droppable.has(id)) {
      candidate.remove()
      this.flowPending.delete(id)
      const event: DeliveryEvent = { kind: 'drop', id, data: pending.data }
      this.events.push(event)
      this.notify?.(event)
      return 0
    }
    if (!this.canSend(id)) {
      candidate.block()
      return 0
    }
    if (pending.droppedOutput === true) {
      candidate.remove()
      this.flowPending.delete(id)
      this.sendFinal(id, pending)
      return 1
    }

    const indivisible = pending.transformed === true
    const data = indivisible ? pending.data : pending.data.slice(0, CHUNK_CHARS)
    const remaining = indivisible ? '' : pending.data.slice(CHUNK_CHARS)
    if (remaining) {
      const next: PendingPtyData = { data: remaining }
      if (typeof pending.startSeq === 'number') {
        next.startSeq = pending.startSeq + data.length
      }
      candidate.replace(next)
      this.flowPending.set(id, remaining.length)
    } else {
      candidate.remove()
      this.flowPending.delete(id)
    }

    const rawLength = pending.rawLength ?? data.length
    this.recordSend(id, rawLength)
    const event: DeliveryEvent = {
      kind: 'data',
      id,
      data,
      rawLength,
      ...(pending.transformed === true ? { transformed: true } : {})
    }
    this.events.push(event)
    this.notify?.(event)
    return 1
  }

  private legacyCandidate(id: string, pending: PendingPtyData): Candidate {
    return {
      id,
      pending,
      block: () => {},
      remove: () => {
        this.legacyPending.delete(id)
      },
      replace: (next) => {
        this.legacyPending.delete(id)
        this.legacyPending.set(id, next)
      }
    }
  }

  private queueCandidate(selection: PtyPendingDataDrainSelection): Candidate {
    const queue = this.queue!
    return {
      id: selection.id,
      pending: selection.pending,
      block: () => queue.block(selection),
      remove: () => queue.remove(selection),
      replace: (pending) => queue.replaceWithRemainder(selection, pending)
    }
  }
}

type EnginePair = { legacy: DrainSchedulerEngine; queue: DrainSchedulerEngine }

function createPair(): EnginePair {
  return {
    legacy: new DrainSchedulerEngine('legacy'),
    queue: new DrainSchedulerEngine('queue')
  }
}

function applyBoth(pair: EnginePair, operation: (engine: DrainSchedulerEngine) => void): void {
  operation(pair.legacy)
  operation(pair.queue)
  expect(pair.queue.snapshot()).toEqual(pair.legacy.snapshot())
}

function dataEvents(engine: DrainSchedulerEngine): Extract<DeliveryEvent, { kind: 'data' }>[] {
  return engine.events.filter(
    (event): event is Extract<DeliveryEvent, { kind: 'data' }> => event.kind === 'data'
  )
}

describe('PTY pending-data scheduler legacy differential', () => {
  it('models scheduled ticks and positive, zero, duplicate, stale, and clamped ACKs', () => {
    const pair = createPair()
    applyBoth(pair, (engine) => engine.enqueue('a', { data: 'abcdefghijklmnopqrst' }))
    applyBoth(pair, (engine) => engine.tick())
    applyBoth(pair, (engine) => engine.tick())
    applyBoth(pair, (engine) => engine.tick())

    const rebuildsBeforeZeroCredit = pair.queue.debugQueue().laneRebuildCount
    applyBoth(pair, (engine) => engine.acknowledge('a', 0))
    const armsAfterZeroCredit = pair.queue.snapshot().timerArmCount
    applyBoth(pair, (engine) => engine.acknowledge('a', -4))
    expect(pair.queue.snapshot().timerArmCount).toBe(armsAfterZeroCredit)
    applyBoth(pair, (engine) => engine.tick())
    expect(pair.queue.debugQueue().laneRebuildCount).toBe(rebuildsBeforeZeroCredit)

    applyBoth(pair, (engine) => engine.acknowledge('a', 4))
    applyBoth(pair, (engine) => engine.tick())
    expect(pair.queue.debugQueue().laneRebuildCount).toBe(rebuildsBeforeZeroCredit + 1)

    const scheduledBeforeReplay = pair.queue.snapshot().scheduledDelay
    const armsBeforeReplay = pair.queue.snapshot().timerArmCount
    applyBoth(pair, (engine) => engine.acknowledge('a', 4))
    applyBoth(pair, (engine) => engine.acknowledge('a', 2))
    applyBoth(pair, (engine) => engine.acknowledge('a', 999))
    applyBoth(pair, (engine) => engine.acknowledge('a', 999))
    expect(pair.queue.snapshot()).toMatchObject({
      scheduledDelay: scheduledBeforeReplay,
      timerArmCount: armsBeforeReplay
    })

    applyBoth(pair, (engine) => engine.tick())
    applyBoth(pair, (engine) => engine.tick())
    expect(pair.queue.snapshot()).toMatchObject({
      pending: [],
      scheduledDelay: null,
      totalInFlight: 8
    })
  })

  it('wakes all globally blocked IDs when credit arrives for a different PTY', () => {
    const pair = createPair()
    applyBoth(pair, (engine) =>
      engine.enqueue('creditor', { data: '12345678', rawLength: 8, transformed: true })
    )
    applyBoth(pair, (engine) => engine.enqueue('blocked-b', { data: 'bbbbbbbb' }))
    applyBoth(pair, (engine) => engine.enqueue('blocked-c', { data: 'cccc' }))
    applyBoth(pair, (engine) => engine.tick())
    applyBoth(pair, (engine) => engine.tick())

    expect(pair.queue.snapshot()).toMatchObject({
      totalInFlight: TOTAL_LIMIT,
      scheduledDelay: null
    })
    applyBoth(pair, (engine) => engine.acknowledge('creditor', 4))
    applyBoth(pair, (engine) => engine.tick())

    expect(dataEvents(pair.queue).at(-1)).toMatchObject({
      id: 'blocked-c',
      data: 'cccc'
    })
  })

  it('reclassifies blocked work for per-PTY and global active reserves', () => {
    const perPty = createPair()
    applyBoth(perPty, (engine) => engine.enqueue('active-later', { data: 'abcdefghijkl' }))
    applyBoth(perPty, (engine) => engine.tick())
    applyBoth(perPty, (engine) => engine.tick())
    applyBoth(perPty, (engine) => engine.tick())
    applyBoth(perPty, (engine) => engine.setActive('active-later', true))
    applyBoth(perPty, (engine) => engine.tick())
    expect(perPty.queue.snapshot()).toMatchObject({ pending: [], totalInFlight: 12 })

    const global = createPair()
    applyBoth(global, (engine) =>
      engine.enqueue('bulk-a', { data: 'aaaaaaaa', rawLength: 8, transformed: true })
    )
    applyBoth(global, (engine) =>
      engine.enqueue('bulk-b', { data: 'bbbb', rawLength: 4, transformed: true })
    )
    applyBoth(global, (engine) => engine.tick())
    applyBoth(global, (engine) => engine.enqueue('active-at-cap', { data: 'cccc' }))
    applyBoth(global, (engine) => engine.tick())
    applyBoth(global, (engine) => engine.setActive('active-at-cap', true))
    applyBoth(global, (engine) => engine.tick())
    expect(dataEvents(global.queue).at(-1)).toMatchObject({
      id: 'active-at-cap',
      data: 'cccc'
    })
  })

  it('orders final payloads before exit and only wakes blocked work for net-new credit', () => {
    const pair = createPair()
    applyBoth(pair, (engine) =>
      engine.enqueue('credit-a', { data: 'aaaaaaaa', rawLength: 8, transformed: true })
    )
    applyBoth(pair, (engine) =>
      engine.enqueue('credit-b', { data: 'bbbb', rawLength: 4, transformed: true })
    )
    applyBoth(pair, (engine) => engine.tick())
    applyBoth(pair, (engine) => engine.enqueue('final', { data: 'tail' }))
    applyBoth(pair, (engine) => engine.enqueue('held', { data: 'held' }))
    applyBoth(pair, (engine) => engine.tick())

    const eventStart = pair.queue.events.length
    const rebuildsBeforeNoopExit = pair.queue.debugQueue().laneRebuildCount
    applyBoth(pair, (engine) => engine.exit('final'))
    expect(pair.queue.events.slice(eventStart)).toEqual([
      { kind: 'data', id: 'final', data: 'tail', rawLength: 4 },
      { kind: 'exit', id: 'final' }
    ])
    expect(pair.queue.snapshot()).toMatchObject({
      totalInFlight: TOTAL_LIMIT,
      flowPending: [['held', 4]],
      scheduledDelay: null
    })
    expect(pair.queue.debugQueue().laneRebuildCount).toBe(rebuildsBeforeNoopExit)

    pair.legacy.exit('credit-a')
    pair.queue.exit('credit-a')
    expect(pair.legacy.snapshot().scheduledDelay).toBeNull()
    expect(pair.queue.snapshot().scheduledDelay).toBe(0)
    expect(pair.queue.snapshot()).toMatchObject({
      pending: pair.legacy.snapshot().pending,
      accounting: pair.legacy.snapshot().accounting,
      totalInFlight: pair.legacy.snapshot().totalInFlight,
      flowPending: pair.legacy.snapshot().flowPending,
      events: pair.legacy.snapshot().events
    })
  })

  it('coalesces zero-write reentrant exit credit into a post-round wakeup', () => {
    const pair = createPair()
    applyBoth(pair, (engine) =>
      engine.enqueue('credit-a', { data: 'aaaaaaaa', rawLength: 8, transformed: true })
    )
    applyBoth(pair, (engine) =>
      engine.enqueue('credit-b', { data: 'bbbb', rawLength: 4, transformed: true })
    )
    applyBoth(pair, (engine) => engine.tick())
    applyBoth(pair, (engine) => engine.enqueue('held', { data: 'held' }))
    applyBoth(pair, (engine) => engine.enqueue('hidden', { data: 'drop' }))
    applyBoth(pair, (engine) => engine.setDroppable('hidden', true))
    for (const engine of [pair.legacy, pair.queue]) {
      let exited = false
      engine.setNotification((event) => {
        if (!exited && event.kind === 'drop' && event.id === 'hidden') {
          exited = true
          engine.exit('credit-a')
        }
      })
    }

    pair.legacy.tick()
    pair.queue.tick()

    expect(pair.legacy.snapshot().scheduledDelay).toBeNull()
    expect(pair.queue.snapshot().scheduledDelay).toBe(0)
    expect(pair.queue.snapshot()).toMatchObject({
      pending: pair.legacy.snapshot().pending,
      accounting: pair.legacy.snapshot().accounting,
      totalInFlight: pair.legacy.snapshot().totalInFlight,
      flowPending: pair.legacy.snapshot().flowPending,
      events: pair.legacy.snapshot().events
    })
    pair.queue.tick()
    expect(dataEvents(pair.queue).at(-1)).toMatchObject({ id: 'held', data: 'held' })
  })

  it('preserves dropped sentinel payloads before exit without leaving its timer armed', () => {
    const pair = createPair()
    applyBoth(pair, (engine) => engine.enqueue('sentinel', { data: 'query', droppedOutput: true }))
    applyBoth(pair, (engine) => engine.exit('sentinel'))
    expect(pair.queue.events).toEqual([
      {
        kind: 'data',
        id: 'sentinel',
        data: 'query',
        rawLength: 5,
        droppedOutput: true
      },
      { kind: 'exit', id: 'sentinel' }
    ])
    expect(pair.queue.snapshot()).toMatchObject({
      pending: [],
      scheduledDelay: null,
      totalInFlight: 0
    })
  })

  it('matches notification-reentrant exit and clear ordering', () => {
    const exitPair = createPair()
    applyBoth(exitPair, (engine) => engine.enqueue('partial', { data: 'abcdefgh' }))
    applyBoth(exitPair, (engine) => engine.enqueue('next', { data: 'next' }))
    for (const engine of [exitPair.legacy, exitPair.queue]) {
      let exited = false
      engine.setNotification((event) => {
        if (!exited && event.kind === 'data' && event.id === 'partial') {
          exited = true
          engine.exit('partial')
        }
      })
    }
    applyBoth(exitPair, (engine) => engine.tick())
    expect(exitPair.queue.events).toEqual([
      { kind: 'tick', delayMs: 2 },
      { kind: 'data', id: 'partial', data: 'abcd', rawLength: 4 },
      { kind: 'data', id: 'partial', data: 'efgh', rawLength: 4 },
      { kind: 'exit', id: 'partial' },
      { kind: 'data', id: 'next', data: 'next', rawLength: 4 }
    ])
    expect(exitPair.queue.snapshot()).toMatchObject({
      pending: [],
      flowPending: [],
      scheduledDelay: null
    })

    const clearPair = createPair()
    applyBoth(clearPair, (engine) => engine.enqueue('first', { data: 'abcdefgh' }))
    applyBoth(clearPair, (engine) => engine.enqueue('detached', { data: 'detached' }))
    for (const engine of [clearPair.legacy, clearPair.queue]) {
      let cleared = false
      engine.setNotification((event) => {
        if (!cleared && event.kind === 'data') {
          cleared = true
          engine.clear()
        }
      })
    }
    applyBoth(clearPair, (engine) => engine.tick())
    expect(clearPair.queue.events).toEqual([
      { kind: 'tick', delayMs: 2 },
      { kind: 'data', id: 'first', data: 'abcd', rawLength: 4 },
      { kind: 'clear' }
    ])
    expect(clearPair.queue.snapshot()).toMatchObject({
      pending: [],
      accounting: [],
      flowPending: [],
      scheduledDelay: null,
      totalInFlight: 0
    })
    expect(clearPair.queue.debugQueue()).toMatchObject({
      activeHeadId: null,
      activeTailId: null,
      backgroundHeadId: null,
      backgroundTailId: null,
      blockedHeadId: null,
      blockedTailId: null,
      openRound: null
    })
  })
})
