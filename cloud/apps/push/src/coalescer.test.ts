import type { PushNotification } from '@orca-cloud/push-contract'
import { describe, expect, it } from 'vitest'
import { PushCoalescer, summaryBody, type CoalescerTimer } from './coalescer.js'
import type { PushDelivery } from './push-delivery-message.js'

const HOST = 'abcdefghijklmnop'

function notification(overrides: Partial<PushNotification> = {}): PushNotification {
  return {
    notificationId: 'note-1',
    notificationSeq: 1,
    notificationEpoch: 'epoch-1',
    source: 'agent-task-complete',
    agentState: 'needs-input',
    title: 'Agent needs input',
    body: 'Waiting on your answer',
    worktreeId: 'wt-1',
    ...overrides
  }
}

// A manual timer queue so a 3s window is exercised without waiting 3s.
function createTimerHarness() {
  const pending = new Map<number, () => void>()
  let nextId = 0
  return {
    delays: [] as number[],
    setTimer(callback: () => void, delayMs: number): CoalescerTimer {
      const handle = nextId++
      pending.set(handle, callback)
      this.delays.push(delayMs)
      return { handle }
    },
    clearTimer(timer: CoalescerTimer): void {
      pending.delete(timer.handle as number)
    },
    fireAll(): void {
      for (const callback of [...pending.values()]) callback()
    }
  }
}

function createCoalescer(windowMs = 3_000) {
  const timers = createTimerHarness()
  const delivered: PushDelivery[] = []
  const coalescer = new PushCoalescer({
    windowMs,
    deliver: async (delivery) => {
      delivered.push(delivery)
    },
    setTimer: (callback, delayMs) => timers.setTimer(callback, delayMs),
    clearTimer: (timer) => timers.clearTimer(timer)
  })
  return { coalescer, delivered, timers }
}

describe('push coalescer', () => {
  it('sends a single event unchanged with the notification collapse id', async () => {
    const { coalescer, delivered, timers } = createCoalescer()
    coalescer.enqueue({ registrationId: 'reg-1', hostFingerprint: HOST, notification: notification() })
    expect(timers.delays).toEqual([3_000])
    expect(delivered).toHaveLength(0)
    await coalescer.flush('reg-1')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      registrationId: 'reg-1',
      title: 'Agent needs input',
      body: 'Waiting on your answer',
      collapseId: 'note-1'
    })
    expect(delivered[0]?.orca).toMatchObject({
      hostFingerprint: HOST,
      notificationId: 'note-1',
      notificationSeq: 1,
      worktreeId: 'wt-1',
      coalescedCount: 1
    })
  })

  it('falls back to the host collapse id when the event carries no notification id', async () => {
    const { coalescer, delivered } = createCoalescer()
    const { notificationId: _absent, ...bell } = notification({ source: 'terminal-bell' })
    coalescer.enqueue({
      registrationId: 'reg-1',
      hostFingerprint: HOST,
      notification: { ...bell, agentState: null }
    })
    await coalescer.flush('reg-1')
    expect(delivered[0]?.collapseId).toBe(`host:${HOST}`)
    expect(delivered[0]?.orca.notificationId).toBeUndefined()
  })

  it('summarises a burst and collapses it under the host id', async () => {
    const { coalescer, delivered } = createCoalescer()
    for (const seq of [1, 2, 3]) {
      coalescer.enqueue({
        registrationId: 'reg-1',
        hostFingerprint: HOST,
        notification: notification({ notificationId: `note-${seq}`, notificationSeq: seq })
      })
    }
    expect(coalescer.pendingCount('reg-1')).toBe(3)
    await coalescer.flush('reg-1')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      title: 'Orca',
      body: '3 agents need attention',
      collapseId: `host:${HOST}`
    })
    // The data carries the latest event, so a tap still opens the newest work.
    expect(delivered[0]?.orca).toMatchObject({
      notificationId: 'note-3',
      notificationSeq: 3,
      coalescedCount: 3
    })
  })

  it('says updates when no event in the burst needs input', async () => {
    const { coalescer, delivered } = createCoalescer()
    for (const seq of [1, 2]) {
      coalescer.enqueue({
        registrationId: 'reg-1',
        hostFingerprint: HOST,
        notification: notification({ notificationSeq: seq, agentState: 'finished' })
      })
    }
    await coalescer.flush('reg-1')
    expect(delivered[0]?.body).toBe('2 updates')
    expect(summaryBody([notification({ agentState: null }), notification({ agentState: null })]))
      .toBe('2 updates')
  })

  it('keeps one window per registration', async () => {
    const { coalescer, delivered, timers } = createCoalescer()
    coalescer.enqueue({ registrationId: 'reg-1', hostFingerprint: HOST, notification: notification() })
    coalescer.enqueue({ registrationId: 'reg-2', hostFingerprint: HOST, notification: notification() })
    coalescer.enqueue({ registrationId: 'reg-1', hostFingerprint: HOST, notification: notification() })
    expect(timers.delays).toHaveLength(2)
    await coalescer.flushAll()
    expect(delivered.map((delivery) => delivery.registrationId).sort()).toEqual(['reg-1', 'reg-2'])
    expect(delivered.find((d) => d.registrationId === 'reg-1')?.orca.coalescedCount).toBe(2)
    expect(delivered.find((d) => d.registrationId === 'reg-2')?.orca.coalescedCount).toBe(1)
  })

  it('flushes when the window timer fires and starts a fresh window after', async () => {
    const { coalescer, delivered, timers } = createCoalescer()
    coalescer.enqueue({ registrationId: 'reg-1', hostFingerprint: HOST, notification: notification() })
    timers.fireAll()
    await Promise.resolve()
    expect(delivered).toHaveLength(1)
    coalescer.enqueue({ registrationId: 'reg-1', hostFingerprint: HOST, notification: notification() })
    expect(coalescer.pendingCount('reg-1')).toBe(1)
    await coalescer.flushAll()
    expect(delivered).toHaveLength(2)
  })

  it('reports a delivery failure instead of throwing into the caller', async () => {
    const failures: unknown[] = []
    const coalescer = new PushCoalescer({
      windowMs: 0,
      deliver: async () => {
        throw new Error('provider down')
      },
      setTimer: () => ({ handle: null }),
      clearTimer: () => undefined,
      onDeliveryFailed: (error) => failures.push(error)
    })
    coalescer.enqueue({ registrationId: 'reg-1', hostFingerprint: HOST, notification: notification() })
    await expect(coalescer.flush('reg-1')).resolves.toBeUndefined()
    expect(failures).toHaveLength(1)
    coalescer.stop()
  })
})
