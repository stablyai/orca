import { describe, expect, it, vi } from 'vitest'
import type { PtySourceCreditAckBatch } from '../../shared/pty-source-credit-contract'
import { SshPtySourceAckCoalescer } from './ssh-pty-source-ack-coalescer'

function publication(token: number, endSu: number, settled = vi.fn(), providerGeneration = 1) {
  const identity = {
    id: `pty-${token}`,
    providerGeneration,
    clientGeneration: 1,
    ownerGeneration: 1,
    ptyIncarnation: `incarnation-${token}`,
    deliveryToken: `token-${token}`
  }
  return {
    identity,
    ack: {
      id: identity.id,
      clientGeneration: 1,
      ownerGeneration: 1,
      deliveryToken: identity.deliveryToken,
      creditedEndSu: endSu
    },
    onSettled: settled
  }
}

describe('SshPtySourceAckCoalescer', () => {
  it('coalesces cumulative values and advances them only from the write callback', () => {
    const writes: {
      batch: PtySourceCreditAckBatch
      settle: (result: { ok: true } | { ok: false; error: Error }) => void
    }[] = []
    const firstSettled = vi.fn()
    const latestSettled = vi.fn()
    const coalescer = new SshPtySourceAckCoalescer({
      publish: (_providerGeneration, batch, settle) => writes.push({ batch, settle }),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coalescer.enqueue(publication(1, 10, firstSettled))
    coalescer.enqueue(publication(1, 20, latestSettled))
    coalescer.flush()

    expect(writes[0].batch.acknowledgements).toEqual([
      expect.objectContaining({ deliveryToken: 'token-1', creditedEndSu: 20 })
    ])
    expect(latestSettled).not.toHaveBeenCalled()
    writes[0].settle({ ok: true })
    expect(latestSettled).toHaveBeenCalledWith({ ok: true })
    expect(firstSettled).toHaveBeenCalledWith({ ok: true })
  })

  it('limits one batch to 64 tokens and gives the remainder another turn', () => {
    const batches: PtySourceCreditAckBatch[] = []
    const scheduled: (() => void)[] = []
    const coalescer = new SshPtySourceAckCoalescer({
      publish: (_providerGeneration, batch, settle) => {
        batches.push(batch)
        settle({ ok: true })
      },
      schedule: (callback) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn()
    })
    for (let token = 0; token < 70; token++) {
      coalescer.enqueue(publication(token, 1))
    }

    coalescer.flush()
    expect(batches[0].acknowledgements).toHaveLength(64)
    scheduled.at(-1)!()
    expect(batches[1].acknowledgements).toHaveLength(6)
  })

  it('never mixes provider generations in one transport batch', () => {
    const generations: number[] = []
    const coalescer = new SshPtySourceAckCoalescer({
      publish: (providerGeneration, _batch, settle) => {
        generations.push(providerGeneration)
        settle({ ok: true })
      },
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coalescer.enqueue(publication(1, 1, vi.fn(), 1))
    coalescer.enqueue(publication(2, 1, vi.fn(), 2))

    coalescer.flush()
    coalescer.flush()

    expect(generations).toEqual([1, 2])
  })

  it('settles every entry as failed on a synchronous send error', () => {
    const settled = vi.fn()
    const coalescer = new SshPtySourceAckCoalescer({
      publish: () => {
        throw new Error('send failed')
      },
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coalescer.enqueue(publication(1, 10, settled))
    coalescer.flush()

    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ message: 'send failed' })
    })
  })

  it('promotes a pending interval flush to immediate at the source threshold', () => {
    const delays: number[] = []
    const cancelSchedule = vi.fn()
    const coalescer = new SshPtySourceAckCoalescer({
      publish: vi.fn(),
      schedule: (_callback, delayMs) => {
        delays.push(delayMs)
        return delays.length as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule
    })

    coalescer.enqueue(publication(1, 1))
    coalescer.enqueue(publication(1, 64 * 1024))

    expect(delays).toEqual([8, 0])
    expect(cancelSchedule).toHaveBeenCalledOnce()
  })

  it('fails queued callbacks exactly once during cleanup', () => {
    const settled = vi.fn()
    const coalescer = new SshPtySourceAckCoalescer({
      publish: vi.fn(),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coalescer.enqueue(publication(1, 10, settled))

    coalescer.dispose()
    coalescer.dispose()
    expect(settled).toHaveBeenCalledOnce()
  })

  it('owns an in-flight callback until dispose and ignores its late transport callback', () => {
    let transportSettle!: (result: { ok: true } | { ok: false; error: Error }) => void
    const settled = vi.fn()
    const coalescer = new SshPtySourceAckCoalescer({
      publish: (_providerGeneration, _batch, settle) => {
        transportSettle = settle
      },
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coalescer.enqueue(publication(1, 10, settled))
    coalescer.flush()

    coalescer.dispose('generation closed')
    transportSettle({ ok: true })
    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ message: 'generation closed' })
    })
  })
})
