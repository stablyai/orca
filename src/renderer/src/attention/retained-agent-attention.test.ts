import { beforeEach, expect, it, vi } from 'vitest'

const deliver = vi.fn()
const dismiss = vi.fn()
vi.mock('../store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))
vi.mock('./agent-attention-notification-delivery', () => ({
  deliverAgentAttentionNotification: (...args: unknown[]) => deliver(...args),
  readAgentAttentionNotificationSound: () => null
}))
vi.mock('../../../shared/notifications/notification-source', () => ({
  notificationSourceForOwner: () => 'source'
}))

const { createRetainedAgentAttentionReceiver } = await import('./retained-agent-attention')

beforeEach(() => {
  deliver.mockClear()
  dismiss.mockClear()
  vi.stubGlobal('window', { api: { notifications: { dismiss } } })
})

const catalog = (id: string) => ({ runtimeEnvironments: [{ id }] })

const notices = (host: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    notificationId: `${host}-${index}`,
    title: 'Mail waiting',
    body: `notice ${index}`
  }))

it.each([10, 100])(
  'keeps no notice state for removed hosts across 20 add/remove cycles (%i notices each)',
  (count) => {
    const receiver = createRetainedAgentAttentionReceiver()
    receiver.reconcile('survivor', notices('survivor', 1))
    for (let cycle = 0; cycle < 20; cycle++) {
      receiver.reconcile(`removed-${cycle}`, notices(`removed-${cycle}`, count))
      receiver.keepCatalogEnvironments(catalog('survivor'))
    }
    expect(receiver.presentedNoticeCount()).toBe(1)

    receiver.reconcile('survivor', [])
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(receiver.presentedNoticeCount()).toBe(0)
  }
)

it('keeps a catalogued host’s notices across a disconnect so its reconnect snapshot does not alert again', () => {
  const receiver = createRetainedAgentAttentionReceiver()
  receiver.reconcile('host', notices('host', 2))
  receiver.keepCatalogEnvironments(catalog('host'))
  receiver.reconcile('host', notices('host', 2))
  expect(deliver).toHaveBeenCalledTimes(2)
})
