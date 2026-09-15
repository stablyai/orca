import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_TASK_STALL_MS,
  StructuredAgentSessionTaskQueue,
  type StructuredAgentSessionTaskStall
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

describe('StructuredAgentSessionTaskQueue stall reporting', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a task that has not settled past the stall threshold', async () => {
    vi.useFakeTimers()
    const stalls: StructuredAgentSessionTaskStall[] = []
    const queue = new StructuredAgentSessionTaskQueue({ onStalled: (stall) => stalls.push(stall) })
    void queue.serialize('session-1', () => new Promise<void>(() => {}))

    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_TASK_STALL_MS - 1)
    expect(stalls).toEqual([])
    await vi.advanceTimersByTimeAsync(2)

    expect(stalls).toEqual([
      { sessionId: 'session-1', ageMs: STRUCTURED_AGENT_SESSION_TASK_STALL_MS }
    ])
    expect(queue.stalledTasks()).toEqual([
      { sessionId: 'session-1', ageMs: STRUCTURED_AGENT_SESSION_TASK_STALL_MS + 1 }
    ])
  })

  it('does not report a task that settles inside the threshold', async () => {
    vi.useFakeTimers()
    const onStalled = vi.fn()
    const queue = new StructuredAgentSessionTaskQueue({ stallMs: 1_000, onStalled })

    await expect(queue.serialize('session-1', async () => 'done')).resolves.toBe('done')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(onStalled).not.toHaveBeenCalled()
    expect(queue.stalledTasks()).toEqual([])
  })

  it('reports a parked chain once and neither cancels nor reorders it', async () => {
    vi.useFakeTimers()
    const onStalled = vi.fn()
    const queue = new StructuredAgentSessionTaskQueue({ stallMs: 1_000, onStalled })
    const parked = Promise.withResolvers<string>()
    const order: string[] = []
    const first = queue.serialize('session-1', async () => {
      order.push('first')
      return parked.promise
    })
    const followers = ['second', 'third'].map((name) =>
      queue.serialize('session-1', async () => {
        order.push(name)
        return name
      })
    )

    await vi.advanceTimersByTimeAsync(5_000)
    expect(onStalled).toHaveBeenCalledTimes(1)
    // Why: reporting must not release the chain; the parked task still owns it.
    expect(order).toEqual(['first'])

    parked.resolve('first-result')
    await expect(first).resolves.toBe('first-result')
    await expect(Promise.all(followers)).resolves.toEqual(['second', 'third'])
    expect(order).toEqual(['first', 'second', 'third'])
    expect(onStalled).toHaveBeenCalledTimes(1)
  })

  it('clears the stalled snapshot once the reported task settles', async () => {
    vi.useFakeTimers()
    const queue = new StructuredAgentSessionTaskQueue({ stallMs: 1_000 })
    const parked = Promise.withResolvers<void>()
    const task = queue.serialize('session-1', () => parked.promise)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(queue.stalledTasks()).toEqual([{ sessionId: 'session-1', ageMs: 2_000 }])

    parked.resolve()
    await task

    expect(queue.stalledTasks()).toEqual([])
  })

  it('reports a rejected parked task only for the session that stalled', async () => {
    vi.useFakeTimers()
    const stalls: StructuredAgentSessionTaskStall[] = []
    const queue = new StructuredAgentSessionTaskQueue({
      stallMs: 1_000,
      onStalled: (stall) => stalls.push(stall)
    })
    void queue.serialize('session-1', () => new Promise<void>(() => {}))
    await expect(queue.serialize('session-2', async () => 'other')).resolves.toBe('other')

    await vi.advanceTimersByTimeAsync(2_000)

    expect(stalls.map((stall) => stall.sessionId)).toEqual(['session-1'])
  })
})
