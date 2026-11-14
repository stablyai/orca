import { describe, expect, it } from 'vitest'
import {
  MobileNotificationReplayBuffer,
  type ReplayableMobileNotification
} from './mobile-notification-replay'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'

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
  it('returns the retained buffer when the watermark came from a previous desktop run', () => {
    // #8591: persisted seq 57 against a restarted seq 2 suppresses catch-up unless epochs invalidate the watermark.
    const previousRun = new MobileNotificationReplayBuffer()
    for (let i = 0; i < 57; i++) {
      dispatch(previousRun, { notificationId: `old:${i}` })
    }
    const staleWatermark = 57
    const staleEpoch = previousRun.epoch

    const afterRestart = new MobileNotificationReplayBuffer()
    dispatch(afterRestart, { notificationId: 'agent:one' })
    dispatch(afterRestart, { notificationId: 'agent:two' })

    expect(afterRestart.getMissedSince(staleWatermark)).toEqual([])
    expect(
      afterRestart.getMissedSince(staleWatermark, staleEpoch).map((e) => e.notificationId)
    ).toEqual(['agent:one', 'agent:two'])
  })

  it('evicts oldest entries once the capacity is exceeded', () => {
    const buffer = new MobileNotificationReplayBuffer(2)
    dispatch(buffer, { notificationId: 'agent:one' })
    dispatch(buffer, { notificationId: 'agent:two' })
    dispatch(buffer, { notificationId: 'agent:three' })

    const retained = buffer.getMissedSince(0).map((e) => e.notificationId)
    expect(retained).toEqual(['agent:two', 'agent:three'])
    expect(buffer.size).toBe(2)
  })
})
