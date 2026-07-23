import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SSH_PTY_CREDIT_SEGMENTS,
  MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE,
  MAX_SSH_PTY_CREDIT_STATE_ID_BYTES,
  MAX_SSH_PTY_CREDIT_STATES,
  SshPtyOutputDeliveryCredit
} from './ssh-pty-output-delivery-credit'
import {
  MAX_SSH_PTY_DELIVERY_TOKEN_BYTES,
  MAX_SSH_RELAY_PTY_ID_BYTES
} from './ssh-pty-wire-admission'

function retainedStates(credit: SshPtyOutputDeliveryCredit): Map<string, { segments: unknown[] }> {
  return Reflect.get(credit, 'states') as Map<string, { segments: unknown[] }>
}

describe('SshPtyOutputDeliveryCredit', () => {
  it('defers tokenized credit until the captured owner acknowledges renderer progress', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    let upstreamCredit: { charCount: number; acknowledge(chars: number): void } | undefined

    credit.ingest(
      {
        id: 'pty-1',
        data: 'output',
        rawLength: 10,
        deliveryToken: 'delivery-1'
      },
      (output) => {
        upstreamCredit = output.upstreamCredit
      }
    )

    expect(notifyAck).not.toHaveBeenCalled()
    upstreamCredit?.acknowledge(4)
    upstreamCredit?.acknowledge(20)

    expect(notifyAck).toHaveBeenNthCalledWith(1, {
      id: 'pty-1',
      charCount: 4,
      deliveryToken: 'delivery-1'
    })
    expect(notifyAck).toHaveBeenNthCalledWith(2, {
      id: 'pty-1',
      charCount: 6,
      deliveryToken: 'delivery-1'
    })
  })

  it('acknowledges a later dropped segment without consuming earlier visible credit', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    let first: { acknowledge(chars: number): void } | undefined
    let second: { acknowledge(chars: number): void } | undefined
    credit.ingest({ id: 'pty-1', data: 'first', deliveryToken: 'delivery-1' }, (output) => {
      first = output.upstreamCredit
    })
    credit.ingest({ id: 'pty-1', data: 'second', deliveryToken: 'delivery-1' }, (output) => {
      second = output.upstreamCredit
    })

    second?.acknowledge(6)
    first?.acknowledge(5)

    expect(notifyAck.mock.calls).toEqual([
      [{ id: 'pty-1', charCount: 6, deliveryToken: 'delivery-1' }],
      [{ id: 'pty-1', charCount: 5, deliveryToken: 'delivery-1' }]
    ])
  })

  it('walks token segments in order for legacy provider acknowledgement calls', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    credit.ingest({ id: 'pty-1', data: 'first', deliveryToken: 'token-1' }, () => {})
    credit.ingest({ id: 'pty-1', data: 'second', deliveryToken: 'token-1' }, () => {})

    credit.acknowledgeLegacy('pty-1', 11)

    expect(notifyAck.mock.calls).toEqual([
      [{ id: 'pty-1', charCount: 5, deliveryToken: 'token-1' }],
      [{ id: 'pty-1', charCount: 6, deliveryToken: 'token-1' }]
    ])
  })

  it('drops stale credit when attach rotates the delivery token', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    let stale: { acknowledge(chars: number): void } | undefined
    let current: { acknowledge(chars: number): void } | undefined
    credit.ingest({ id: 'pty-1', data: 'stale', deliveryToken: 'before-attach' }, (output) => {
      stale = output.upstreamCredit
    })
    credit.ingest({ id: 'pty-1', data: 'current', deliveryToken: 'after-attach' }, (output) => {
      current = output.upstreamCredit
    })

    current?.acknowledge(7)
    stale?.acknowledge(5)
    credit.ingest({ id: 'pty-1', data: 'next', deliveryToken: 'after-attach' }, () => {})
    credit.acknowledgeLegacy('pty-1', 4)

    expect(notifyAck.mock.calls).toEqual([
      [{ id: 'pty-1', charCount: 7, deliveryToken: 'after-attach' }],
      [{ id: 'pty-1', charCount: 4, deliveryToken: 'after-attach' }]
    ])
  })

  it('preserves legacy no-token acknowledgements', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    credit.ingest({ id: 'pty-1', data: 'legacy' }, () => {})

    credit.acknowledgeLegacy('pty-1', 6)

    expect(notifyAck).toHaveBeenCalledWith({ id: 'pty-1', charCount: 6 })
  })

  it('falls back to delivered length when raw length is invalid', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    let upstreamCredit: { acknowledge(chars: number): void } | undefined
    credit.ingest(
      {
        id: 'pty-1',
        data: 'output',
        rawLength: Number.POSITIVE_INFINITY,
        deliveryToken: 'delivery-2'
      },
      (output) => {
        upstreamCredit = output.upstreamCredit
      }
    )

    upstreamCredit?.acknowledge(100)

    expect(notifyAck).toHaveBeenCalledWith({
      id: 'pty-1',
      charCount: 6,
      deliveryToken: 'delivery-2'
    })
  })

  it('makes captured credit inert after exit or disposal', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    let exited: { acknowledge(chars: number): void } | undefined
    let disposed: { acknowledge(chars: number): void } | undefined
    credit.ingest({ id: 'pty-1', data: 'exit', deliveryToken: 'delivery-3' }, (output) => {
      exited = output.upstreamCredit
    })
    credit.release('pty-1')
    exited?.acknowledge(4)
    credit.ingest({ id: 'pty-2', data: 'dispose', deliveryToken: 'delivery-4' }, (output) => {
      disposed = output.upstreamCredit
    })

    credit.dispose()
    disposed?.acknowledge(7)

    expect(notifyAck).not.toHaveBeenCalled()
  })

  it('returns delivery credit when listener ingestion throws', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)

    expect(() =>
      credit.ingest({ id: 'pty-1', data: 'output', deliveryToken: 'delivery-5' }, () => {
        throw new Error('listener failed')
      })
    ).toThrow('listener failed')
    expect(notifyAck).toHaveBeenCalledWith({
      id: 'pty-1',
      charCount: 6,
      deliveryToken: 'delivery-5'
    })
  })

  it('rejects oversized ids and delivery tokens before retention', () => {
    const deliver = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(vi.fn())

    credit.ingest(
      {
        id: 'x'.repeat(MAX_SSH_RELAY_PTY_ID_BYTES + 1),
        data: 'output',
        deliveryToken: 'token'
      },
      deliver
    )
    credit.ingest(
      {
        id: 'pty-1',
        data: 'output',
        deliveryToken: 'x'.repeat(MAX_SSH_PTY_DELIVERY_TOKEN_BYTES + 1)
      },
      deliver
    )

    expect(deliver).not.toHaveBeenCalled()
    expect(retainedStates(credit)).toHaveLength(0)
  })

  it('caps unique-id credit state churn and returns evicted credit', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    for (let index = 0; index < MAX_SSH_PTY_CREDIT_STATES + 50; index += 1) {
      credit.ingest({ id: `pty-${index}`, data: 'x', deliveryToken: `token-${index}` }, () => {})
    }

    const states = retainedStates(credit)
    expect(states.size).toBe(MAX_SSH_PTY_CREDIT_STATES)
    expect(states.has('pty-0')).toBe(false)
    expect(states.has(`pty-${MAX_SSH_PTY_CREDIT_STATES + 49}`)).toBe(true)
    expect(notifyAck).toHaveBeenCalledWith({
      id: 'pty-0',
      charCount: 1,
      deliveryToken: 'token-0'
    })
  })

  it('caps aggregate credit-state id bytes', () => {
    const credit = new SshPtyOutputDeliveryCredit(vi.fn())
    const suffix = 'x'.repeat(MAX_SSH_RELAY_PTY_ID_BYTES - 16)
    for (let index = 0; index < MAX_SSH_PTY_CREDIT_STATES; index += 1) {
      credit.ingest(
        { id: `pty-${index}:${suffix}`, data: 'x', deliveryToken: `token-${index}` },
        () => {}
      )
    }

    const retainedBytes = [...retainedStates(credit).keys()].reduce(
      (total, id) => total + Buffer.byteLength(id),
      0
    )
    expect(retainedBytes).toBeLessThanOrEqual(MAX_SSH_PTY_CREDIT_STATE_ID_BYTES)
    expect(retainedStates(credit).size).toBeLessThan(MAX_SSH_PTY_CREDIT_STATES)
  })

  it('caps retained segments per state and in aggregate', () => {
    const credit = new SshPtyOutputDeliveryCredit(vi.fn())
    const perStateTotal = MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE + 50
    for (let index = 0; index < perStateTotal; index += 1) {
      credit.ingest({ id: 'pty-one', data: 'x', deliveryToken: 'token-one' }, () => {})
    }
    expect(retainedStates(credit).get('pty-one')?.segments).toHaveLength(
      MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE
    )

    for (let state = 0; state < 8; state += 1) {
      for (let segment = 0; segment < MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE; segment += 1) {
        credit.ingest({ id: `pty-${state}`, data: 'x', deliveryToken: `token-${state}` }, () => {})
      }
    }

    const retained = [...retainedStates(credit).values()].reduce(
      (total, state) => total + state.segments.length,
      0
    )
    expect(retained).toBe(MAX_SSH_PTY_CREDIT_SEGMENTS)
  })

  it('returns unretained direct credit when state churn evicts its owner', () => {
    const notifyAck = vi.fn()
    const credit = new SshPtyOutputDeliveryCredit(notifyAck)
    for (let index = 0; index <= MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE; index += 1) {
      credit.ingest({ id: 'pty-direct', data: 'x', deliveryToken: 'token-direct' }, () => {})
    }
    for (let index = 0; index < MAX_SSH_PTY_CREDIT_STATES; index += 1) {
      credit.ingest({ id: `pty-${index}`, data: 'x', deliveryToken: `token-${index}` }, () => {})
    }

    expect(notifyAck).toHaveBeenCalledWith({
      id: 'pty-direct',
      charCount: MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE + 1,
      deliveryToken: 'token-direct'
    })
  })
})
