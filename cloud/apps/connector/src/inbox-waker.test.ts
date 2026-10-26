import type { CloudNotifications, ListenHandlers } from '@orca-cloud/cloud-database'
import { describe, expect, it } from 'vitest'
import { InboxWaker } from './inbox-waker.js'

function fakeNotifications() {
  let handlers: ListenHandlers | null = null
  const notifications: CloudNotifications = {
    notify: async () => {},
    listen: async (_channel, next) => {
      handlers = next
      return async () => {}
    }
  }
  return { notifications, handlers: () => handlers! }
}

describe('inbox waker', () => {
  it('wakes only the named host, and every waiter after the listener reconnects', async () => {
    const fake = fakeNotifications()
    const waker = new InboxWaker(fake.notifications)
    await waker.start()
    const woken: string[] = []
    const a = waker.register('a').wait(5_000).then(() => woken.push('a'))
    const b = waker.register('b').wait(5_000).then(() => woken.push('b'))
    fake.handlers().onNotify('a')
    await a
    expect(woken).toEqual(['a'])
    fake.handlers().onReconnect()
    await b
    expect(woken).toEqual(['a', 'b'])
  })

  it('keeps a notification that lands between registering and waiting', async () => {
    const fake = fakeNotifications()
    const waker = new InboxWaker(fake.notifications)
    await waker.start()
    const waiter = waker.register('a')
    fake.handlers().onNotify('a')
    const startedAt = Date.now()
    await waiter.wait(5_000)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
