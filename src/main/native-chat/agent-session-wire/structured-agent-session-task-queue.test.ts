import { describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

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
