import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayDispatcher, RelayNotificationWriteResult } from './dispatcher'
import { PTY_OUTPUT_HIGH_WATER_CHARS, PtyOutputBroadcast } from './pty-output-broadcast'

type Delivery = {
  clientId: number
  data: string
  deliveryToken: string
}

function createDispatcher(clientIds: number[]) {
  const connected = new Set(clientIds)
  const detachListeners = new Set<(clientId: number) => void>()
  const deliveries: Delivery[] = []
  const evicted: number[] = []
  const writers = new Map<
    number,
    (delivery: Delivery) => RelayNotificationWriteResult | undefined
  >()
  const dispatcher = {
    connectedClientIds: () => Array.from(connected),
    onClientDetached: (listener: (clientId: number) => void) => {
      detachListeners.add(listener)
      return () => detachListeners.delete(listener)
    },
    notifyClientWithBackpressure: (
      clientId: number,
      _method: string,
      params: Record<string, unknown> = {}
    ): RelayNotificationWriteResult => {
      const delivery = {
        clientId,
        data: String(params.data ?? ''),
        deliveryToken: String(params.deliveryToken ?? '')
      }
      deliveries.push(delivery)
      return (
        writers.get(clientId)?.(delivery) ?? {
          delivered: true,
          saturated: false,
          drained: Promise.resolve()
        }
      )
    },
    evictClient: (clientId: number) => {
      if (!connected.delete(clientId)) {
        return
      }
      evicted.push(clientId)
      for (const listener of detachListeners) {
        listener(clientId)
      }
    }
  } as unknown as RelayDispatcher
  return { dispatcher, deliveries, evicted, writers }
}

function deliveryData(deliveries: Delivery[], clientId: number): string {
  return deliveries
    .filter((delivery) => delivery.clientId === clientId)
    .map((delivery) => delivery.data)
    .join('')
}

describe('PtyOutputBroadcast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('broadcasts identical ordered output to every healthy client', async () => {
    const { dispatcher, deliveries } = createDispatcher([1, 2])
    const output = new PtyOutputBroadcast(dispatcher)
    output.register('pty-1', { pause: vi.fn(), resume: vi.fn() })

    output.enqueue('pty-1', { data: 'hello ' })
    output.enqueue('pty-1', { data: 'world' })
    await vi.advanceTimersByTimeAsync(20)

    expect(deliveryData(deliveries, 1)).toBe('hello world')
    expect(deliveryData(deliveries, 2)).toBe('hello world')
  })

  it('lets a transiently saturated client drain its exact backlog without stalling peers', async () => {
    const { dispatcher, deliveries, writers } = createDispatcher([1, 2])
    let signalDrain!: () => void
    let firstWrite = true
    writers.set(1, () => {
      if (!firstWrite) {
        return undefined
      }
      firstWrite = false
      return {
        delivered: true,
        saturated: true,
        drained: new Promise<void>((resolve) => {
          signalDrain = resolve
        })
      }
    })
    const output = new PtyOutputBroadcast(dispatcher)
    output.register('pty-1', { pause: vi.fn(), resume: vi.fn() })

    output.enqueue('pty-1', { data: 'first' })
    await vi.advanceTimersByTimeAsync(8)
    output.enqueue('pty-1', { data: ' second' })
    await vi.advanceTimersByTimeAsync(8)

    expect(deliveryData(deliveries, 1)).toBe('first')
    expect(deliveryData(deliveries, 2)).toBe('first second')

    signalDrain()
    await Promise.resolve()

    expect(deliveryData(deliveries, 1)).toBe('first second')
    expect(deliveryData(deliveries, 2)).toBe('first second')
  })

  it('evicts only a permanently slow observer at the shared backlog bound', async () => {
    const { dispatcher, deliveries, evicted, writers } = createDispatcher([1, 2])
    writers.set(1, () => ({
      delivered: true,
      saturated: true,
      drained: new Promise<void>(() => {})
    }))
    const pause = vi.fn()
    const output = new PtyOutputBroadcast(dispatcher)
    output.register('pty-1', { pause, resume: vi.fn() })
    const chunk = 'x'.repeat(16 * 1024)

    for (let index = 0; index <= PTY_OUTPUT_HIGH_WATER_CHARS / chunk.length; index++) {
      output.enqueue('pty-1', { data: chunk })
      await vi.advanceTimersByTimeAsync(8)
      const healthyDelivery = deliveries.findLast((delivery) => delivery.clientId === 2)
      output.acknowledge(
        {
          id: 'pty-1',
          charCount: chunk.length,
          deliveryToken: healthyDelivery?.deliveryToken
        },
        { clientId: 2, isStale: () => false }
      )
    }

    expect(evicted).toEqual([1])
    expect(deliveryData(deliveries, 2)).toHaveLength(PTY_OUTPUT_HIGH_WATER_CHARS + chunk.length)
    expect(pause).not.toHaveBeenCalled()

    output.enqueue('pty-1', { data: 'tail' })
    await vi.advanceTimersByTimeAsync(20)
    expect(deliveryData(deliveries, 2).endsWith('tail')).toBe(true)
  })

  it('pauses all-blocked producers and rejects cross-client or stale credit', async () => {
    const { dispatcher, deliveries } = createDispatcher([7])
    const pause = vi.fn()
    const resume = vi.fn()
    const output = new PtyOutputBroadcast(dispatcher)
    output.register('pty-1', { pause, resume })

    output.enqueue('pty-1', { data: 'x'.repeat(PTY_OUTPUT_HIGH_WATER_CHARS) })
    const deliveryToken = deliveries[0]?.deliveryToken

    expect(pause).toHaveBeenCalledOnce()
    output.acknowledge(
      { id: 'pty-1', charCount: PTY_OUTPUT_HIGH_WATER_CHARS, deliveryToken },
      { clientId: 8, isStale: () => false }
    )
    output.acknowledge(
      { id: 'pty-1', charCount: PTY_OUTPUT_HIGH_WATER_CHARS, deliveryToken: 'stale' },
      { clientId: 7, isStale: () => false }
    )
    expect(resume).not.toHaveBeenCalled()

    output.acknowledge(
      { id: 'pty-1', charCount: PTY_OUTPUT_HIGH_WATER_CHARS, deliveryToken },
      { clientId: 7, isStale: () => false }
    )
    expect(resume).toHaveBeenCalledOnce()
  })

  it('rotates only the reattaching client token and preserves other observers', async () => {
    const { dispatcher, deliveries } = createDispatcher([1, 2])
    const output = new PtyOutputBroadcast(dispatcher)
    output.register('pty-1', { pause: vi.fn(), resume: vi.fn() })

    output.enqueue('pty-1', { data: 'before' })
    await vi.advanceTimersByTimeAsync(20)
    const oldOne = deliveries.find((delivery) => delivery.clientId === 1)?.deliveryToken
    const oldTwo = deliveries.find((delivery) => delivery.clientId === 2)?.deliveryToken

    output.resetClient('pty-1', 1)
    output.enqueue('pty-1', { data: 'after' })
    await vi.advanceTimersByTimeAsync(20)
    const latestOne = deliveries.findLast((delivery) => delivery.clientId === 1)?.deliveryToken
    const latestTwo = deliveries.findLast((delivery) => delivery.clientId === 2)?.deliveryToken

    expect(latestOne).not.toBe(oldOne)
    expect(latestTwo).toBe(oldTwo)
    expect(deliveryData(deliveries, 2)).toBe('beforeafter')
  })

  it('cancels drain waiters and releases a paused producer on cleanup', async () => {
    const { dispatcher, writers } = createDispatcher([1])
    const cancelDrain = vi.fn()
    writers.set(1, () => ({
      delivered: true,
      saturated: true,
      drained: new Promise<void>(() => {}),
      cancelDrain
    }))
    const pause = vi.fn()
    const resume = vi.fn()
    const output = new PtyOutputBroadcast(dispatcher)
    output.register('pty-1', { pause, resume })

    output.enqueue('pty-1', { data: 'blocked' })
    await vi.advanceTimersByTimeAsync(8)
    expect(pause).toHaveBeenCalledOnce()

    output.unregister('pty-1')

    expect(resume).toHaveBeenCalledOnce()
    expect(cancelDrain).toHaveBeenCalledOnce()
  })

  it('queues the bounded final tail before exit even when normal credit is exhausted', () => {
    const { dispatcher, deliveries } = createDispatcher([1, 2])
    const output = new PtyOutputBroadcast(dispatcher)
    output.register('pty-1', { pause: vi.fn(), resume: vi.fn() })
    const data = `${'x'.repeat(PTY_OUTPUT_HIGH_WATER_CHARS)}final tail`

    output.enqueue('pty-1', { data })
    expect(deliveryData(deliveries, 1)).toHaveLength(PTY_OUTPUT_HIGH_WATER_CHARS)
    expect(deliveryData(deliveries, 2)).toHaveLength(PTY_OUTPUT_HIGH_WATER_CHARS)

    output.flushForExit('pty-1')

    expect(deliveryData(deliveries, 1)).toBe(data)
    expect(deliveryData(deliveries, 2)).toBe(data)
  })
})
