import { describe, expect, it } from 'vitest'
import {
  MobileNotificationReplayBuffer,
  type ReplayableMobileNotification
} from './mobile-notification-replay'
import type { MobileNotificationDispatchEvent } from './orca-runtime'

function dispatch(
  buffer: MobileNotificationReplayBuffer,
  partial: Partial<MobileNotificationDispatchEvent> = {}
): ReplayableMobileNotification {
  const event: MobileNotificationDispatchEvent = {
    type: 'notification',
    source: 'agent-task-complete',
    title: 'Done',
    body: 'Finished.',
    ...partial
  }
  buffer.record(event)
  return buffer.getMissedSince(0).at(-1) as ReplayableMobileNotification
}

describe('MobileNotificationReplayBuffer', () => {
  it('assigns a strictly increasing monotonic notificationSeq to every recorded event', () => {
    const buffer = new MobileNotificationReplayBuffer()
    const a = dispatch(buffer, { notificationId: 'agent:one' })
    const b = dispatch(buffer, { notificationId: 'agent:two' })
    const c = dispatch(buffer, { notificationId: 'agent:three' })
    expect(a.notificationSeq).toBe(1)
    expect(b.notificationSeq).toBe(2)
    expect(c.notificationSeq).toBe(3)
    expect(c.notificationSeq).toBeGreaterThan(b.notificationSeq)
    expect(b.notificationSeq).toBeGreaterThan(a.notificationSeq)
  })

  // Why: the client watermarks + dedups on `notificationSeq` (the same field
  // the live fan-out tags). Replayed events must expose that exact field —
  // returning a bare `seq` here silently breaks watermark advance on a
  // replay-only delivery (regression guard for the #8129 field mismatch).
  it('exposes the client-facing `notificationSeq` field on replayed events', () => {
    const buffer = new MobileNotificationReplayBuffer()
    const a = dispatch(buffer, { notificationId: 'agent:one' })
    expect(a.notificationSeq).toBe(1)
    expect((a as Record<string, unknown>).seq).toBeUndefined()
  })

  it('returns missed notifications that were dispatched after the watermark', () => {
    const buffer = new MobileNotificationReplayBuffer()
    dispatch(buffer, { notificationId: 'agent:one' })
    const b = dispatch(buffer, { notificationId: 'agent:two' })
    dispatch(buffer, { notificationId: 'agent:three' })

    // Client reconnected having delivered up to seq 1.
    const missed = buffer.getMissedSince(b.notificationSeq - 1)
    expect(missed.map((e) => e.notificationId)).toEqual(['agent:two', 'agent:three'])
  })

  it('does NOT return already-delivered notifications (dedupe regression)', () => {
    const buffer = new MobileNotificationReplayBuffer()
    const a = dispatch(buffer, { notificationId: 'agent:one' })
    dispatch(buffer, { notificationId: 'agent:two' })
    dispatch(buffer, { notificationId: 'agent:three' })

    // Client already delivered everything up to seq 3, then reconnects again.
    const missed = buffer.getMissedSince(a.notificationSeq + 2)
    expect(missed).toEqual([])
  })

  it('is idempotent: the same watermark always yields the same set', () => {
    const buffer = new MobileNotificationReplayBuffer()
    dispatch(buffer, { notificationId: 'agent:one' })
    dispatch(buffer, { notificationId: 'agent:two' })
    dispatch(buffer, { notificationId: 'agent:three' })

    const first = buffer.getMissedSince(1)
    const second = buffer.getMissedSince(1)
    expect(second).toEqual(first)
    expect(second.map((e) => e.notificationId)).toEqual(['agent:two', 'agent:three'])
  })

  it('does not duplicate an event that arrived on both live stream and replay', () => {
    const buffer = new MobileNotificationReplayBuffer()
    const a = dispatch(buffer, { notificationId: 'agent:one' })
    dispatch(buffer, { notificationId: 'agent:two' })

    // Live stream delivered seq 1 (agent:one) during a brief liveness spell.
    // Reconnect asks for everything after 0 — must include agent:one exactly
    // once, never twice.
    const missed = buffer.getMissedSince(a.notificationSeq - 1)
    const ids = missed.map((e) => e.notificationId)
    expect(ids).toEqual(['agent:one', 'agent:two'])
    expect(ids.filter((id) => id === 'agent:one')).toHaveLength(1)
  })

  it('returns the whole buffer when the watermark is 0 (cold open)', () => {
    const buffer = new MobileNotificationReplayBuffer()
    dispatch(buffer, { notificationId: 'agent:one' })
    dispatch(buffer, { notificationId: 'agent:two' })
    expect(buffer.getMissedSince(0).map((e) => e.notificationId)).toEqual([
      'agent:one',
      'agent:two'
    ])
  })

  it('returns the retained buffer when the watermark came from a previous desktop run', () => {
    // The #8591 defect: `seq` is per-process and restarts at 0 every launch, but the
    // client's watermark is persisted. A client holding seq 57 meets a counter at 2,
    // `57 >= 2` cuts everything, and catch-up stays dead until the new process
    // dispatches 57 notifications. The epoch is what makes the two distinguishable.
    const previousRun = new MobileNotificationReplayBuffer()
    for (let i = 0; i < 57; i++) {
      dispatch(previousRun, { notificationId: `old:${i}` })
    }
    const staleWatermark = 57
    const staleEpoch = previousRun.epoch

    const afterRestart = new MobileNotificationReplayBuffer()
    dispatch(afterRestart, { notificationId: 'agent:one' })
    dispatch(afterRestart, { notificationId: 'agent:two' })

    // Seq-only (the old behaviour) still silently drops everything...
    expect(afterRestart.getMissedSince(staleWatermark)).toEqual([])
    // ...but a watermark tagged with the old epoch is recognised as void.
    expect(
      afterRestart.getMissedSince(staleWatermark, staleEpoch).map((e) => e.notificationId)
    ).toEqual(['agent:one', 'agent:two'])
  })

  it('keeps the exact seq cut when the epoch matches the live counter', () => {
    const buffer = new MobileNotificationReplayBuffer()
    const first = dispatch(buffer, { notificationId: 'agent:one' })
    dispatch(buffer, { notificationId: 'agent:two' })

    // Same counter: the epoch must not widen the cut into a re-push of delivered events.
    expect(
      buffer.getMissedSince(first.notificationSeq, buffer.epoch).map((e) => e.notificationId)
    ).toEqual(['agent:two'])
    expect(buffer.getMissedSince(2, buffer.epoch)).toEqual([])
  })

  it('stamps every recorded event with the buffer epoch, and epochs differ per process', () => {
    const buffer = new MobileNotificationReplayBuffer()
    const event = dispatch(buffer, { notificationId: 'agent:one' })

    expect(event.notificationEpoch).toBe(buffer.epoch)
    // A restart must produce a different epoch or the watermark stays ambiguous.
    expect(new MobileNotificationReplayBuffer().epoch).not.toBe(buffer.epoch)
  })

  it('evicts oldest entries once the capacity is exceeded', () => {
    const buffer = new MobileNotificationReplayBuffer(2)
    dispatch(buffer, { notificationId: 'agent:one' })
    dispatch(buffer, { notificationId: 'agent:two' })
    dispatch(buffer, { notificationId: 'agent:three' })

    // Capacity is 2, so the first entry is evicted; even from watermark 0 we
    // only get the two retained plus the newest.
    const retained = buffer.getMissedSince(0).map((e) => e.notificationId)
    expect(retained).toEqual(['agent:two', 'agent:three'])
    expect(buffer.size).toBe(2)
  })
})
