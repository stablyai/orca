import { once } from 'node:events'
import { Socket } from 'node:net'
import { expect, it } from 'vitest'
import { DeferredProviderOwner } from './deferred-provider-owner'

it('closes a deferred pipe whose owner socket closed before attachment', async () => {
  const owner = new DeferredProviderOwner()
  const endpoints = new Map([1, 2, 3, 4, 5, 6, 7].map((fd) => [fd, new Socket()]))
  const status = endpoints.get(5)!
  const closed = once(status, 'close')
  status.destroy()
  await closed
  try {
    owner.attach(123, endpoints)
    expect(owner.stdio[5]?.destroyed).toBe(true)
  } finally {
    for (const stream of [...owner.stdio, ...endpoints.values()]) {
      stream?.on('error', () => {})
      stream?.destroy()
    }
  }
})
