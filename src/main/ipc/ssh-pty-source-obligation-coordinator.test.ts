import { describe, expect, it, vi } from 'vitest'
import type {
  PtySourceCreditAckBatch,
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import { SshPtySourceObligationCoordinator } from './ssh-pty-source-obligation-coordinator'

const identity: PtySourceDeliveryIdentity = {
  id: 'pty-1',
  providerGeneration: 1,
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation-1',
  deliveryToken: 'token-1'
}

const span: PtySourceSpan = {
  ...identity,
  spanId: 'span-1',
  sourceStartSu: 0,
  sourceEndSu: 4,
  displayStart: 0,
  displayEnd: 4,
  data: 'data',
  splittable: true,
  transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
}

describe('SshPtySourceObligationCoordinator', () => {
  it('is the single boundary from exact consumer settlement to upstream ACK publication', () => {
    let written:
      | {
          batch: PtySourceCreditAckBatch
          settle: (result: { ok: true } | { ok: false; error: Error }) => void
        }
      | undefined
    const coordinator = new SshPtySourceObligationCoordinator({
      publish: (_providerGeneration, batch, settle) => {
        written = { batch, settle }
      },
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coordinator.open(identity)
    const reservation = coordinator.reserve(identity, span, ['model', 'desktop'])
    coordinator.commit(reservation)
    coordinator.settle({
      identity,
      spanId: span.spanId,
      consumer: 'model',
      reason: 'emulator-receipt'
    })
    coordinator.settle({
      identity,
      spanId: span.spanId,
      consumer: 'desktop',
      reason: 'renderer-parse'
    })
    coordinator.flushAcknowledgements()

    expect(written?.batch.acknowledgements).toEqual([
      expect.objectContaining({ deliveryToken: 'token-1', creditedEndSu: 4 })
    ])
    expect(coordinator.snapshot(identity).ackPublishedEndSu).toBe(0)
    written?.settle({ ok: true })
    expect(coordinator.snapshot(identity).ackPublishedEndSu).toBe(4)
  })

  it('rejects an adapter transition carrying a stale full delivery identity', () => {
    const coordinator = new SshPtySourceObligationCoordinator({
      publish: vi.fn(),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coordinator.open(identity)
    coordinator.commit(coordinator.reserve(identity, span, ['model']))

    expect(() =>
      coordinator.settle({
        identity: { ...identity, ownerGeneration: 99 },
        spanId: span.spanId,
        consumer: 'model',
        reason: 'stale'
      })
    ).toThrow('stale')
  })

  it('keeps later generations publishable after closing one generation', () => {
    const publish = vi.fn()
    const coordinator = new SshPtySourceObligationCoordinator({
      publish,
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coordinator.open(identity)
    coordinator.closeGeneration(1, 'replaced')
    const nextIdentity = { ...identity, providerGeneration: 2, deliveryToken: 'token-2' }
    const nextSpan = { ...span, ...nextIdentity, spanId: 'span-2' }
    coordinator.open(nextIdentity)
    coordinator.commit(coordinator.reserve(nextIdentity, nextSpan, ['model']))
    coordinator.settle({
      identity: nextIdentity,
      spanId: nextSpan.spanId,
      consumer: 'model',
      reason: 'accepted'
    })
    coordinator.flushAcknowledgements()

    expect(publish).toHaveBeenCalledWith(
      2,
      {
        acknowledgements: [expect.objectContaining({ deliveryToken: 'token-2', creditedEndSu: 4 })]
      },
      expect.any(Function)
    )
  })

  it('generation-closes every retained token on coordinator disposal', () => {
    const coordinator = new SshPtySourceObligationCoordinator({
      publish: vi.fn(),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn()
    })
    coordinator.open(identity)
    coordinator.commit(coordinator.reserve(identity, span, ['model']))

    coordinator.dispose('provider disposed')

    expect(coordinator.snapshot(identity)).toMatchObject({
      state: 'closed',
      generationClosed: true,
      openSpans: 0
    })
    expect(() => coordinator.open({ ...identity, deliveryToken: 'late-token' })).toThrow('disposed')
  })
})
