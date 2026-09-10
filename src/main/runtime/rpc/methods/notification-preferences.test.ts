import { expect, it } from 'vitest'
import { NOTIFICATION_METHODS } from './notifications'
import { RuntimeMobileNotificationController } from '../../runtime-mobile-notification-controller'
import type { RpcContext, RpcStreamingMethod, RpcMethod } from '../core'

it('keeps desktop-disabled events out of legacy live and replay streams', async () => {
  const controller = new RuntimeMobileNotificationController()
  const cleanups: (() => void)[] = []
  const runtime = {
    onNotificationDispatched: controller.onDispatched.bind(controller),
    getMobileNotificationEpoch: controller.getEpoch.bind(controller),
    getMissedNotificationsSince: controller.getMissedSince.bind(controller),
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => cleanups.push(cleanup)
  }
  const ctx = { runtime } as unknown as RpcContext
  const subscribe = NOTIFICATION_METHODS.find(
    (method) => method.name === 'notifications.subscribe'
  ) as RpcStreamingMethod
  const replay = NOTIFICATION_METHODS.find(
    (method) => method.name === 'notifications.getMissedSince'
  ) as RpcMethod
  const legacy: unknown[] = []
  const current: unknown[] = []
  const pending = [
    subscribe.handler({}, ctx, (event) => legacy.push(event)),
    subscribe.handler({ includeDesktopSuppressed: true }, ctx, (event) => current.push(event))
  ]
  controller.dispatch({
    type: 'notification',
    source: 'terminal-bell',
    title: 'bell',
    body: '',
    desktopAllowed: false
  })
  controller.dispatch({
    type: 'notification',
    source: 'agent-task-complete',
    title: 'done',
    body: ''
  })
  expect(legacy).toHaveLength(2)
  expect(current).toHaveLength(3)
  expect(legacy[1]).toMatchObject({ title: 'done' })
  expect(current[1]).toMatchObject({ desktopAllowed: false })
  expect(await replay.handler({ lastSeenSeq: 0 }, ctx)).toMatchObject({
    notifications: [{ title: 'done' }]
  })
  const result = (await replay.handler(
    { lastSeenSeq: 0, includeDesktopSuppressed: true },
    ctx
  )) as { notifications: unknown[] }
  expect(result.notifications).toHaveLength(2)
  cleanups.forEach((cleanup) => cleanup())
  await Promise.all(pending)
})

it('preserves legacy workspace cooldown while letting current phones filter before cooldown', async () => {
  const { createNotificationStreamFilter } = await import('./notification-stream-policy')
  const events = [
    {
      type: 'notification' as const,
      source: 'terminal-bell' as const,
      title: '',
      body: '',
      worktreeId: 'folder',
      emittedAt: 10000
    },
    {
      type: 'notification' as const,
      source: 'agent-task-complete' as const,
      title: '',
      body: '',
      worktreeId: 'folder',
      emittedAt: 10250
    }
  ]
  expect(events.filter(createNotificationStreamFilter())).toEqual([events[0]])
  expect(events.filter(createNotificationStreamFilter(true))).toEqual(events)
})
