import { describe, expect, it, vi } from 'vitest'
import {
  PendingOperationDrain,
  StructuredAgentSessionTaskQueue
} from './structured-agent-session-task-queue'

function pendingChainCount(queue: StructuredAgentSessionTaskQueue): number {
  return (queue as unknown as { chains: Map<string, Promise<void>> }).chains.size
}

describe('StructuredAgentSessionTaskQueue', () => {
  it('deletes a successful settled tail', async () => {
    const queue = new StructuredAgentSessionTaskQueue()

    await expect(queue.serialize('session-1', async () => 'done')).resolves.toBe('done')
    await Promise.resolve()

    expect(pendingChainCount(queue)).toBe(0)
  })

  it('deletes a rejected settled tail without poisoning the next task', async () => {
    const queue = new StructuredAgentSessionTaskQueue()

    await expect(
      queue.serialize('session-1', async () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    await expect(queue.serialize('session-1', async () => 'recovered')).resolves.toBe('recovered')
    await Promise.resolve()

    expect(pendingChainCount(queue)).toBe(0)
  })

  it('does not let an earlier tail cleanup delete an overlapping replacement', async () => {
    const queue = new StructuredAgentSessionTaskQueue()
    const firstGate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const order: string[] = []
    const first = queue.serialize('session-1', async () => {
      order.push('first-start')
      await firstGate.promise
      order.push('first-end')
    })
    const second = queue.serialize('session-1', async () => {
      order.push('second-start')
      await secondGate.promise
      order.push('second-end')
    })

    firstGate.resolve()
    await first
    expect(pendingChainCount(queue)).toBe(1)
    await vi.waitFor(() => expect(order).toEqual(['first-start', 'first-end', 'second-start']))

    secondGate.resolve()
    await second
    await Promise.resolve()
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
    expect(pendingChainCount(queue)).toBe(0)
  })
})

describe('PendingOperationDrain', () => {
  it('drains work enqueued while the drain is already running', async () => {
    const drain = new PendingOperationDrain()
    const second = Promise.withResolvers<void>()
    let secondTracked = false

    drain.track(
      Promise.resolve().then(() => {
        secondTracked = true
        drain.track(second.promise)
      })
    )
    let drained = false
    const draining = drain.drain().then(() => {
      drained = true
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondTracked).toBe(true)
    expect(drained).toBe(false)

    second.resolve()
    await draining
    expect(drained).toBe(true)
  })

  it('drops settled entries and survives a rejected one', async () => {
    const drain = new PendingOperationDrain()
    const rejected = Promise.reject(new Error('recovery failed'))

    expect(drain.track(rejected)).toBe(rejected)
    await expect(drain.drain()).resolves.toBeUndefined()
    expect((drain as unknown as { pending: Set<unknown> }).pending.size).toBe(0)
  })

  it('lets an outer timeout fire while work never settles', async () => {
    const drain = new PendingOperationDrain()
    drain.track(new Promise<void>(() => {}))

    const timedOut = await Promise.race([
      drain.drain().then(() => 'drained' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10))
    ])

    expect(timedOut).toBe('timeout')
  })
})
