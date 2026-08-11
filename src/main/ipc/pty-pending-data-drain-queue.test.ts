import { describe, expect, it } from 'vitest'
import {
  PtyPendingDataDrainQueue,
  type PendingPtyData,
  type PtyPendingDataDrainSelection
} from './pty-pending-data-drain-queue'

function pending(data: string): PendingPtyData {
  return { data }
}

function createQueueState() {
  const active = new Set<string>()
  const blocked = new Set<string>()
  const queue = new PtyPendingDataDrainQueue((id) =>
    blocked.has(id) ? 'blocked' : active.has(id) ? 'active' : 'background'
  )
  return { active, blocked, queue }
}

function takeId(
  queue: PtyPendingDataDrainQueue,
  round: ReturnType<PtyPendingDataDrainQueue['beginRound']>
): string | null {
  return queue.takeNext(round)?.id ?? null
}

describe('PtyPendingDataDrainQueue', () => {
  it('drains active IDs first while preserving Map order within each lane', () => {
    const { active, queue } = createQueueState()
    queue.set('background-1', pending('b1'))
    queue.set('active-1', pending('a1'))
    queue.set('background-2', pending('b2'))
    queue.set('active-2', pending('a2'))
    active.add('active-1')
    active.add('active-2')
    queue.invalidateAll()

    const round = queue.beginRound()
    const order: string[] = []
    for (;;) {
      const selection = queue.takeNext(round)
      if (!selection) {
        break
      }
      order.push(selection.id)
      queue.remove(selection)
    }
    queue.endRound(round)

    expect(order).toEqual(['active-1', 'active-2', 'background-1', 'background-2'])
  })

  it('defers partial remainders beyond the current round frontier without replacing the node', () => {
    const { queue } = createQueueState()
    queue.set('pty-1', { data: 'firsttail', startSeq: 10 })
    const initialDebug = queue.getDebugSnapshot()

    const firstRound = queue.beginRound()
    const selection = queue.takeNext(firstRound)
    expect(selection).toMatchObject({ id: 'pty-1', pending: { data: 'firsttail', startSeq: 10 } })
    queue.replaceWithRemainder(selection!, { data: 'tail', startSeq: 15 })
    expect(queue.takeNext(firstRound)).toBeNull()
    queue.endRound(firstRound)

    const secondRound = queue.beginRound()
    const remainder = queue.takeNext(secondRound)!
    expect(remainder).toBe(selection)
    expect(remainder).toMatchObject({
      id: 'pty-1',
      pending: { data: 'tail', startSeq: 15 }
    })
    queue.remove(remainder)
    queue.endRound(secondRound)

    expect(queue.getDebugSnapshot()).toMatchObject({
      pendingSize: 0,
      createdNodeCount: initialDebug.createdNodeCount,
      peakNodeCount: 1,
      allocationIdsByPty: {}
    })
  })

  it('defers a reentrant append to an unvisited ID and preserves its Map position', () => {
    const { queue } = createQueueState()
    queue.set('a', pending('a'))
    queue.set('b', pending('b'))
    queue.set('c', pending('c'))

    const firstRound = queue.beginRound()
    const first = queue.takeNext(firstRound)!
    expect(first.id).toBe('a')
    queue.remove(first)
    queue.set('b', pending('b+reentrant'))
    expect(queue.getDebugSnapshot().allocationIdsByPty.b).toBe(2)

    const currentRoundOrder: string[] = []
    for (;;) {
      const selection = queue.takeNext(firstRound)
      if (!selection) {
        break
      }
      currentRoundOrder.push(selection.id)
      queue.remove(selection)
    }
    queue.endRound(firstRound)

    expect(currentRoundOrder).toEqual(['c'])
    expect([...queue.keys()]).toEqual(['b'])
    const secondRound = queue.beginRound()
    expect(queue.takeNext(secondRound)).toMatchObject({
      id: 'b',
      pending: { data: 'b+reentrant' }
    })
    queue.endRound(secondRound)
    expect(queue.getDebugSnapshot().createdNodeCount).toBe(3)
  })

  it('rebuilds an earlier reentrant update before an untouched later ID in Map order', () => {
    const { queue } = createQueueState()
    queue.set('trigger', pending('trigger'))
    queue.set('earlier', pending('old'))
    queue.set('later', pending('later'))

    const firstRound = queue.beginRound()
    queue.remove(queue.takeNext(firstRound)!)
    queue.set('earlier', pending('new'))
    queue.endRound(firstRound)

    const secondRound = queue.beginRound()
    const order: string[] = []
    for (;;) {
      const selection = queue.takeNext(secondRound)
      if (!selection) {
        break
      }
      order.push(selection.id)
      queue.remove(selection)
    }
    queue.endRound(secondRound)

    expect(order).toEqual(['earlier', 'later'])
  })

  it('keeps aggregate pending chars exact across every owner transition', () => {
    const { blocked, queue } = createQueueState()
    queue.set('a', pending('abc'))
    queue.set('b', pending('12345'))
    expect(queue.totalPendingChars).toBe(8)

    queue.set('a', pending('abcdef'))
    expect(queue.totalPendingChars).toBe(11)
    blocked.add('a')
    queue.invalidate('a')
    const blockedRound = queue.beginRound()
    const b = queue.takeNext(blockedRound)!
    queue.replaceWithRemainder(b, pending('12'))
    queue.endRound(blockedRound)
    expect(queue.totalPendingChars).toBe(8)

    blocked.delete('a')
    queue.reactivateBlocked()
    const removalRound = queue.beginRound()
    const first = queue.takeNext(removalRound)!
    queue.remove(first)
    queue.endRound(removalRound)
    expect(queue.totalPendingChars).toBe(2)

    expect(queue.delete('b')).toEqual(pending('12'))
    expect(queue.totalPendingChars).toBe(0)
    queue.set('c', pending('tail'))
    queue.clear()
    expect(queue.getDebugSnapshot()).toMatchObject({
      pendingSize: 0,
      totalPendingChars: 0
    })
  })

  it('relinks only when the exact derived settings token changes', () => {
    const settings = {
      terminalMainSideEffectAuthority: true,
      terminalHiddenDeliveryGate: true,
      unrelated: 0
    }
    const queue = new PtyPendingDataDrainQueue(
      () => 'background',
      () => settings.terminalMainSideEffectAuthority && settings.terminalHiddenDeliveryGate
    )
    queue.set('a', pending('a'))
    const firstRound = queue.beginRound()
    queue.endRound(firstRound)
    const baseline = queue.getDebugSnapshot().laneRebuildCount

    settings.unrelated += 1
    const unrelatedRound = queue.beginRound()
    queue.endRound(unrelatedRound)
    expect(queue.getDebugSnapshot().laneRebuildCount).toBe(baseline)

    settings.terminalHiddenDeliveryGate = false
    const disabledRound = queue.beginRound()
    queue.endRound(disabledRound)
    expect(queue.getDebugSnapshot().laneRebuildCount).toBe(baseline + 1)

    settings.terminalMainSideEffectAuthority = false
    settings.terminalHiddenDeliveryGate = true
    const equivalentRound = queue.beginRound()
    queue.endRound(equivalentRound)
    expect(queue.getDebugSnapshot().laneRebuildCount).toBe(baseline + 1)

    settings.terminalMainSideEffectAuthority = true
    const enabledRound = queue.beginRound()
    queue.endRound(enabledRound)
    expect(queue.getDebugSnapshot().laneRebuildCount).toBe(baseline + 2)
  })

  it('does not follow a detached successor after reentrant delete or clear', () => {
    const deleted = createQueueState().queue
    deleted.set('a', pending('a'))
    deleted.set('b', pending('b'))
    deleted.set('c', pending('c'))
    const deleteRound = deleted.beginRound()
    const first = deleted.takeNext(deleteRound)!
    deleted.remove(first)
    deleted.delete('b')
    expect(takeId(deleted, deleteRound)).toBe('c')
    deleted.endRound(deleteRound)

    const cleared = createQueueState().queue
    cleared.set('a', pending('a'))
    cleared.set('b', pending('b'))
    const clearRound = cleared.beginRound()
    cleared.remove(cleared.takeNext(clearRound)!)
    cleared.clear()
    expect(cleared.takeNext(clearRound)).toBeNull()
    cleared.endRound(clearRound)
    expect(cleared.getDebugSnapshot()).toMatchObject({
      pendingSize: 0,
      activeRunnableSize: 0,
      backgroundRunnableSize: 0,
      blockedSize: 0,
      activeHeadId: null,
      activeTailId: null,
      backgroundHeadId: null,
      backgroundTailId: null,
      blockedHeadId: null,
      blockedTailId: null,
      openRound: null,
      activeFrontier: 0,
      backgroundFrontier: 0,
      allocationIdsByPty: {}
    })
  })

  it('reuses nodes through partial, update, and relink churn', () => {
    const { queue } = createQueueState()
    queue.set('a', pending('a'))
    queue.set('b', pending('b'))
    queue.set('c', pending('c'))
    const initialAllocations = queue.getDebugSnapshot().allocationIdsByPty

    for (let index = 0; index < 60; index++) {
      const round = queue.beginRound()
      const selection = queue.takeNext(round)!
      queue.replaceWithRemainder(selection, pending(`${selection.id}-${index}`))
      queue.endRound(round)
      queue.set(selection.id, pending(`${selection.id}-${index}-updated`))
      queue.invalidateAll()
    }

    expect(queue.getDebugSnapshot()).toMatchObject({
      pendingSize: 3,
      createdNodeCount: 3,
      peakNodeCount: 3,
      allocationIdsByPty: initialAllocations
    })

    const finalRound = queue.beginRound()
    queue.clear()
    expect(queue.takeNext(finalRound)).toBeNull()
    expect(queue.getDebugSnapshot()).toMatchObject({
      pendingSize: 0,
      activeRunnableSize: 0,
      backgroundRunnableSize: 0,
      blockedSize: 0,
      activeHeadId: null,
      activeTailId: null,
      backgroundHeadId: null,
      backgroundTailId: null,
      blockedHeadId: null,
      blockedTailId: null,
      openRound: null,
      activeFrontier: 0,
      backgroundFrontier: 0,
      allocationIdsByPty: {}
    })
  })

  it('freezes active classification until the next round', () => {
    const { active, queue } = createQueueState()
    queue.set('a', pending('a'))
    queue.set('b', pending('b'))

    const firstRound = queue.beginRound()
    const first = queue.takeNext(firstRound)!
    expect(first.id).toBe('a')
    queue.remove(first)
    active.add('b')
    queue.invalidateAll()
    expect(takeId(queue, firstRound)).toBe('b')
    queue.endRound(firstRound)

    queue.set('c', pending('c'))
    active.add('c')
    queue.invalidateAll()
    const secondRound = queue.beginRound()
    expect(takeId(queue, secondRound)).toBe('b')
    queue.endRound(secondRound)
  })

  it('reactivates blocked candidates in authoritative Map order', () => {
    const { blocked, queue } = createQueueState()
    blocked.add('a')
    blocked.add('b')
    queue.set('a', pending('a'))
    queue.set('b', pending('b'))

    const blockedRound = queue.beginRound()
    expect(queue.takeNext(blockedRound)).toBeNull()
    queue.endRound(blockedRound)
    expect(queue.getDebugSnapshot().blockedSize).toBe(2)

    blocked.clear()
    expect(queue.reactivateBlocked()).toBe(true)
    const creditedRound = queue.beginRound()
    const first = queue.takeNext(creditedRound)!
    queue.remove(first)
    const second = queue.takeNext(creditedRound)!
    queue.remove(second)
    queue.endRound(creditedRound)
    expect([first.id, second.id]).toEqual(['a', 'b'])
  })

  it('visits 100 one-chunk candidates exactly once across 50 bounded rounds', () => {
    const { queue } = createQueueState()
    const legacy = new Map<string, PendingPtyData>()
    for (let index = 0; index < 100; index++) {
      const id = `pty-${index}`
      const value = pending(String(index))
      queue.set(id, value)
      legacy.set(id, value)
    }

    let rounds = 0
    let timerDecisions = 1
    while (queue.size > 0) {
      rounds += 1
      const round = queue.beginRound()
      for (let writes = 0; writes < 2; writes++) {
        const selection = queue.takeNext(round)
        if (!selection) {
          break
        }
        queue.remove(selection)
      }
      queue.endRound(round)
      if (queue.size > 0) {
        timerDecisions += 1
      }
    }

    let legacySelectionVisits = 0
    let legacyTimerDecisions = 1
    while (legacy.size > 0) {
      const snapshot = [...legacy.keys()]
      legacySelectionVisits += snapshot.length
      for (const id of snapshot.slice(0, 2)) {
        legacy.delete(id)
      }
      if (legacy.size > 0) {
        legacyTimerDecisions += 1
      }
    }

    expect(rounds).toBe(50)
    expect(timerDecisions).toBe(50)
    expect(legacySelectionVisits).toBe(2_550)
    expect(legacyTimerDecisions).toBe(50)
    expect(queue.getDebugSnapshot()).toMatchObject({
      selectionVisitCount: 100,
      createdNodeCount: 100,
      peakNodeCount: 100,
      pendingSize: 0,
      activeRunnableSize: 0,
      backgroundRunnableSize: 0,
      blockedSize: 0,
      activeHeadId: null,
      activeTailId: null,
      backgroundHeadId: null,
      backgroundTailId: null,
      blockedHeadId: null,
      blockedTailId: null,
      openRound: null,
      activeFrontier: 0,
      backgroundFrontier: 0,
      allocationIdsByPty: {}
    })
  })

  it('requires each selection to commit before advancing', () => {
    const { queue } = createQueueState()
    queue.set('a', pending('a'))
    queue.set('b', pending('b'))
    const round = queue.beginRound()
    const selection = queue.takeNext(round)

    expect(() => queue.takeNext(round)).toThrow(
      'PTY pending-data selection must be committed before advancing'
    )
    expect(() => queue.set('a', pending('replacement'))).toThrow(
      'Selected PTY pending data must commit before update'
    )
    queue.block(selection as PtyPendingDataDrainSelection)
    expect(takeId(queue, round)).toBe('b')
    queue.endRound(round)
  })
})
