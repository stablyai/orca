import { describe, expect, it } from 'vitest'
import { PtyPendingDataDrainQueue, type PendingPtyData } from './pty-pending-data-drain-queue'

const CHUNK_CHARS = 4
const MAX_WRITES = 2

type Policy = {
  active: Set<string>
  hidden: Set<string>
  interested: Set<string>
  credit: number
}

type DrainEvent = {
  kind: 'data' | 'drop' | 'marker' | 'sentinel'
  id: string
  data?: string
  startSeq?: number
  rawLength?: number
  transformed?: true
  containsBackgroundOutput?: boolean
}

type DrainResult = {
  events: DrainEvent[]
  flow: { id: string; pendingChars: number }[]
  timer: 'blocked' | 'continue' | 'idle'
  writes: number
}

function createPolicy(): Policy {
  return {
    active: new Set(),
    hidden: new Set(),
    interested: new Set(),
    credit: 2
  }
}

function isDroppable(policy: Policy, id: string): boolean {
  return policy.hidden.has(id) && !policy.interested.has(id)
}

function classify(policy: Policy, id: string) {
  if (!isDroppable(policy, id) && policy.credit <= 0) {
    return 'blocked' as const
  }
  return policy.active.has(id) ? ('active' as const) : ('background' as const)
}

function clonePending(value: PendingPtyData): PendingPtyData {
  return { ...value }
}

function remainderFor(pending: PendingPtyData, chunk: string, remaining: string): PendingPtyData {
  const next: PendingPtyData = { data: remaining }
  if (typeof pending.startSeq === 'number') {
    next.startSeq = pending.startSeq + chunk.length
  }
  if (pending.containsBackgroundOutput === true) {
    next.containsBackgroundOutput = true
  }
  return next
}

function dataEvent(id: string, pending: PendingPtyData, data: string): DrainEvent {
  return {
    kind: 'data',
    id,
    data,
    ...(typeof pending.startSeq === 'number' ? { startSeq: pending.startSeq } : {}),
    ...(typeof pending.rawLength === 'number' ? { rawLength: pending.rawLength } : {}),
    ...(pending.transformed === true ? { transformed: true } : {}),
    ...(pending.containsBackgroundOutput === true ? { containsBackgroundOutput: true } : {})
  }
}

function recordExit(timeline: unknown[], id: string, pending: PendingPtyData | undefined): void {
  if (pending) {
    timeline.push(
      pending.droppedOutput === true
        ? { kind: 'sentinel', id, data: pending.data }
        : dataEvent(id, pending, pending.data)
    )
    timeline.push({ kind: 'flow', id, pendingChars: 0 })
  }
  timeline.push({ kind: 'exit', id, hadPending: pending !== undefined })
}

function timerDecision(size: number, writes: number): DrainResult['timer'] {
  if (size === 0) {
    return 'idle'
  }
  return writes > 0 ? 'continue' : 'blocked'
}

function recordDrop(
  events: DrainEvent[],
  markedDrops: Set<string>,
  id: string,
  pending: PendingPtyData
): void {
  events.push({ kind: 'drop', id, data: pending.data })
  if (!markedDrops.has(id)) {
    markedDrops.add(id)
    events.push({ kind: 'marker', id })
  }
}

function drainLegacy(
  pendingById: Map<string, PendingPtyData>,
  policy: Policy,
  markedDrops: Set<string>
): DrainResult {
  const entries = [...pendingById.entries()]
  const ordered = [
    ...entries.filter(([id]) => policy.active.has(id)),
    ...entries.filter(([id]) => !policy.active.has(id))
  ]
  const events: DrainEvent[] = []
  const flow: DrainResult['flow'] = []
  let writes = 0
  for (const [id, pending] of ordered) {
    if (writes >= MAX_WRITES) {
      break
    }
    if (isDroppable(policy, id)) {
      pendingById.delete(id)
      recordDrop(events, markedDrops, id, pending)
      flow.push({ id, pendingChars: 0 })
      continue
    }
    if (policy.credit <= 0) {
      continue
    }
    pendingById.delete(id)
    if (pending.droppedOutput === true) {
      events.push({ kind: 'sentinel', id, data: pending.data })
    } else {
      const chunk = pending.transformed === true ? pending.data : pending.data.slice(0, CHUNK_CHARS)
      const remaining = pending.transformed === true ? '' : pending.data.slice(CHUNK_CHARS)
      if (remaining) {
        pendingById.set(id, remainderFor(pending, chunk, remaining))
      }
      events.push(dataEvent(id, pending, chunk))
    }
    flow.push({ id, pendingChars: pendingById.get(id)?.data.length ?? 0 })
    policy.credit -= 1
    writes += 1
  }
  return { events, flow, timer: timerDecision(pendingById.size, writes), writes }
}

function drainQueue(
  queue: PtyPendingDataDrainQueue,
  policy: Policy,
  markedDrops: Set<string>
): DrainResult {
  const events: DrainEvent[] = []
  const flow: DrainResult['flow'] = []
  let writes = 0
  const round = queue.beginRound()
  try {
    while (writes < MAX_WRITES) {
      const selection = queue.takeNext(round)
      if (!selection) {
        break
      }
      const { id, pending } = selection
      if (isDroppable(policy, id)) {
        queue.remove(selection)
        recordDrop(events, markedDrops, id, pending)
        flow.push({ id, pendingChars: 0 })
        continue
      }
      if (policy.credit <= 0) {
        queue.block(selection)
        continue
      }
      if (pending.droppedOutput === true) {
        queue.remove(selection)
        events.push({ kind: 'sentinel', id, data: pending.data })
      } else {
        const chunk =
          pending.transformed === true ? pending.data : pending.data.slice(0, CHUNK_CHARS)
        const remaining = pending.transformed === true ? '' : pending.data.slice(CHUNK_CHARS)
        if (remaining) {
          queue.replaceWithRemainder(selection, remainderFor(pending, chunk, remaining))
        } else {
          queue.remove(selection)
        }
        events.push(dataEvent(id, pending, chunk))
      }
      flow.push({ id, pendingChars: queue.get(id)?.data.length ?? 0 })
      policy.credit -= 1
      writes += 1
    }
  } finally {
    queue.endRound(round)
  }
  return { events, flow, timer: timerDecision(queue.size, writes), writes }
}

function nextRandom(state: { value: number }): number {
  let value = state.value
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  state.value = value >>> 0
  return state.value
}

function setMembership(set: Set<string>, id: string, present: boolean): boolean {
  if (present) {
    const changed = !set.has(id)
    set.add(id)
    return changed
  }
  return set.delete(id)
}

function expectEquivalent(
  legacy: Map<string, PendingPtyData>,
  queue: PtyPendingDataDrainQueue,
  legacyPolicy: Policy,
  queuePolicy: Policy,
  legacyTimeline: unknown[],
  queueTimeline: unknown[]
): void {
  expect([...queue.keys()]).toEqual([...legacy.keys()])
  expect([...queue.values()]).toEqual([...legacy.values()])
  expect(queuePolicy.credit).toBe(legacyPolicy.credit)
  expect(queueTimeline).toEqual(legacyTimeline)
}

function runSeed(seed: number): void {
  const legacy = new Map<string, PendingPtyData>()
  const legacyPolicy = createPolicy()
  const queuePolicy = createPolicy()
  const queue = new PtyPendingDataDrainQueue((id) => classify(queuePolicy, id))
  const legacyMarkedDrops = new Set<string>()
  const queueMarkedDrops = new Set<string>()
  const legacyTimeline: unknown[] = []
  const queueTimeline: unknown[] = []
  const random = { value: seed }
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']

  for (let step = 0; step < 800; step++) {
    const choice = nextRandom(random) % 13
    const id = ids[nextRandom(random) % ids.length]!
    if (choice <= 2) {
      const suffix = String.fromCharCode(97 + (nextRandom(random) % 26)).repeat(
        1 + (nextRandom(random) % 6)
      )
      const current = legacy.get(id)
      const next: PendingPtyData = current
        ? { ...current, data: current.data + suffix }
        : {
            data: suffix,
            startSeq: nextRandom(random) % 40,
            ...(nextRandom(random) % 3 === 0 ? { containsBackgroundOutput: true } : {})
          }
      legacy.set(id, clonePending(next))
      queue.set(id, clonePending(next))
    } else if (choice === 3) {
      const active = nextRandom(random) % 2 === 0
      const changed = setMembership(legacyPolicy.active, id, active)
      setMembership(queuePolicy.active, id, active)
      if (changed) {
        queue.invalidateAll()
      }
    } else if (choice === 4 || choice === 5) {
      const setName = choice === 4 ? 'hidden' : 'interested'
      const before = isDroppable(queuePolicy, id)
      const present = nextRandom(random) % 2 === 0
      setMembership(legacyPolicy[setName], id, present)
      setMembership(queuePolicy[setName], id, present)
      if (!present && setName === 'hidden') {
        legacyMarkedDrops.delete(id)
        queueMarkedDrops.delete(id)
      }
      if (before !== isDroppable(queuePolicy, id)) {
        queue.invalidateAll()
      }
    } else if (choice === 6) {
      legacyPolicy.credit += 1
      queuePolicy.credit += 1
      queue.reactivateBlocked()
    } else if (choice === 7) {
      const sentinel = { data: `q${nextRandom(random) % 10}`, droppedOutput: true as const }
      legacy.set(id, clonePending(sentinel))
      queue.set(id, clonePending(sentinel))
    } else if (choice === 8) {
      const legacyPending = legacy.get(id)
      legacy.delete(id)
      const queuePending = queue.delete(id)
      recordExit(legacyTimeline, id, legacyPending)
      recordExit(queueTimeline, id, queuePending)
    } else if (choice === 9) {
      legacy.clear()
      queue.clear()
      legacyMarkedDrops.clear()
      queueMarkedDrops.clear()
      legacyTimeline.push({ kind: 'clear' })
      queueTimeline.push({ kind: 'clear' })
    } else {
      const legacyRound = drainLegacy(legacy, legacyPolicy, legacyMarkedDrops)
      const queueRound = drainQueue(queue, queuePolicy, queueMarkedDrops)
      legacyTimeline.push(legacyRound)
      queueTimeline.push(queueRound)
    }
    expectEquivalent(legacy, queue, legacyPolicy, queuePolicy, legacyTimeline, queueTimeline)
  }
}

describe('PtyPendingDataDrainQueue legacy differential', () => {
  it.each([0x1a2b3c4d, 0x5eedc0de, 0x7f4a7c15])(
    'matches frozen Map drain behavior for seed %i',
    (seed) => {
      runSeed(seed)
    }
  )

  it('defers every form of reentrant work until owner mutation is committed', () => {
    const policy = createPolicy()
    const queue = new PtyPendingDataDrainQueue((id) => classify(policy, id))
    queue.set('partial', { data: 'abcdefgh', startSeq: 10 })
    queue.set('unvisited', { data: 'old' })

    const round = queue.beginRound()
    const partial = queue.takeNext(round)!
    queue.replaceWithRemainder(partial, { data: 'efgh', startSeq: 14 })
    queue.set('new', { data: 'new' })
    queue.set('partial', { data: 'efgh+same', startSeq: 14 })
    queue.set('unvisited', { data: 'old+append' })
    expect(queue.takeNext(round)).toBeNull()
    queue.endRound(round)

    const next = queue.beginRound()
    const ids: string[] = []
    for (;;) {
      const selection = queue.takeNext(next)
      if (!selection) {
        break
      }
      ids.push(selection.id)
      queue.remove(selection)
    }
    queue.endRound(next)
    expect(ids).toEqual(['unvisited', 'partial', 'new'])
  })

  it('preserves transformed indivisibility and raw metadata', () => {
    const policy = createPolicy()
    policy.credit = 1
    const queue = new PtyPendingDataDrainQueue((id) => classify(policy, id))
    queue.set('transformed', {
      data: 'abcdef',
      startSeq: 7,
      rawLength: 19,
      transformed: true,
      containsBackgroundOutput: true
    })

    expect(drainQueue(queue, policy, new Set())).toEqual({
      events: [
        {
          kind: 'data',
          id: 'transformed',
          data: 'abcdef',
          startSeq: 7,
          rawLength: 19,
          transformed: true,
          containsBackgroundOutput: true
        }
      ],
      flow: [{ id: 'transformed', pendingChars: 0 }],
      timer: 'idle',
      writes: 1
    })
  })

  it('applies reentrant active and interest flips at the next frontier rebuild', () => {
    const policy = createPolicy()
    policy.credit = 0
    policy.hidden.add('drop-first')
    policy.hidden.add('blocked')
    policy.interested.add('blocked')
    const queue = new PtyPendingDataDrainQueue((id) => classify(policy, id))
    queue.set('drop-first', { data: 'drop' })
    queue.set('blocked', { data: 'held' })

    const round = queue.beginRound()
    const first = queue.takeNext(round)!
    expect(first.id).toBe('drop-first')
    queue.remove(first)
    policy.active.add('blocked')
    policy.interested.delete('blocked')
    queue.invalidateAll()
    expect(queue.takeNext(round)).toBeNull()
    queue.endRound(round)

    const next = queue.beginRound()
    const reclassified = queue.takeNext(next)!
    expect(reclassified.id).toBe('blocked')
    queue.remove(reclassified)
    queue.endRound(next)
  })
})
