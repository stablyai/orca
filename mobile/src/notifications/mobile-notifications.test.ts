import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { dismissHostPushNotification } from './push-socket-dismissal'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'

vi.mock('./push-socket-dismissal', () => ({
  dismissHostPushNotification: vi.fn(async () => {})
}))
vi.mock('./push-dismissal-reconciliation', () => ({
  requestNotificationCatchup: vi.fn(async () => {})
}))
vi.mock('./notification-permissions', () => ({}))

type Handler = (data: unknown) => void

function client() {
  let handler: Handler | undefined
  return {
    getState: vi.fn(() => 'connected'),
    sendRequest: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn((_method: string, _params: unknown, callback: Handler) => {
      handler = callback
      return vi.fn()
    }),
    emit(data: unknown) {
      handler?.(data)
    }
  }
}

beforeEach(() => vi.clearAllMocks())

describe('subscribeToDesktopNotifications', () => {
  it('never presents an OS banner for socket alert or replay events', async () => {
    const rpc = client()
    subscribeToDesktopNotifications(rpc as never, 'host-1')
    rpc.emit({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    rpc.emit({
      type: 'notification',
      notificationId: 'agent-1',
      title: 'Needs input',
      body: 'Reply',
      source: 'agent-task-complete'
    })
    await Promise.resolve()
    expect(requestNotificationCatchup).toHaveBeenCalledWith(rpc, 'host-1', expect.any(Function))
    expect(dismissHostPushNotification).not.toHaveBeenCalled()
  })

  it('keeps socket dismissal processing active', async () => {
    const rpc = client()
    subscribeToDesktopNotifications(rpc as never, 'host-1')
    rpc.emit({ type: 'ready', subscriptionId: 'sub-1' })
    const dismissal = { type: 'dismiss', notificationId: 'agent-1', notificationSeq: 4 }
    rpc.emit(dismissal)
    await Promise.resolve()
    expect(dismissHostPushNotification).toHaveBeenCalledWith(dismissal, 'host-1')
  })
})
