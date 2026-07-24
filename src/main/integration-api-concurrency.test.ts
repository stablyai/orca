import { describe, expect, it, vi } from 'vitest'
import { IntegrationApiConcurrencyGate } from './integration-api-concurrency'

describe('IntegrationApiConcurrencyGate', () => {
  it('preserves FIFO admission within the ordinary concurrency limit', async () => {
    const gate = new IntegrationApiConcurrencyGate(1, 2)
    const first = gate.acquire()
    const secondResolved = vi.fn()
    const second = gate.acquire().then(secondResolved)

    await first
    expect(secondResolved).not.toHaveBeenCalled()
    gate.release()
    await second

    expect(secondResolved).toHaveBeenCalledTimes(1)
    gate.release()
  })

  it('rejects fan-out beyond the retained waiter cap', async () => {
    const gate = new IntegrationApiConcurrencyGate(1, 2)
    await gate.acquire()
    const queued = [gate.acquire(), gate.acquire()]

    await expect(gate.acquire()).rejects.toThrow('queue is full')

    gate.release()
    await queued[0]
    gate.release()
    await queued[1]
    gate.release()
  })
})
