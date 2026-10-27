import { expect, it } from 'vitest'
import { RuntimeMobileNotificationController } from '../../runtime-mobile-notification-controller'
import { NOTIFICATION_METHODS } from './notifications'
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../core'

it.each([0, 255])(
  'preserves the live cooldown decision after %i intervening replay entries',
  async (filler) => {
    const controller = new RuntimeMobileNotificationController()
    let stop!: () => void
    const ctx = {
      runtime: {
        onNotificationDispatched: controller.onDispatched.bind(controller),
        getMobileNotificationEpoch: controller.getEpoch.bind(controller),
        getMissedNotificationsSince: controller.getMissedSince.bind(controller),
        registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
          stop = cleanup
        }
      }
    } as unknown as RpcContext
    const subscribe = NOTIFICATION_METHODS.find(
      (m) => m.name === 'notifications.subscribe'
    ) as RpcStreamingMethod
    const replay = NOTIFICATION_METHODS.find(
      (m) => m.name === 'notifications.getMissedSince'
    ) as RpcMethod
    const live: unknown[] = []
    const pending = subscribe.handler(undefined, ctx, (e) => live.push(e))
    try {
      controller.dispatch({
        type: 'notification',
        source: 'terminal-bell',
        title: 'first',
        body: '',
        worktreeId: 'folder',
        emittedAt: 10000
      })
      controller.dispatch({
        type: 'notification',
        source: 'agent-task-complete',
        title: 'suppressed',
        body: '',
        worktreeId: 'folder',
        emittedAt: 10250
      })
      expect(live).toHaveLength(2)
      for (let i = 0; i < filler; i++) {
        controller.dispatch({ type: 'dismiss', notificationId: `other-${i}` })
      }
      const result = (await replay.handler(
        { lastSeenSeq: 1, epoch: controller.getEpoch() },
        ctx
      )) as { notifications: { type: string }[] }
      expect(result.notifications.filter((e) => e.type === 'notification')).toEqual([])
      const all = (await replay.handler(
        { lastSeenSeq: 1, epoch: controller.getEpoch(), includeDesktopSuppressed: true },
        ctx
      )) as { notifications: { title?: string }[] }
      expect(all.notifications.some((e) => e.title === 'suppressed')).toBe(true)
    } finally {
      stop()
      await pending
    }
  }
)
