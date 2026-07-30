import { describe, expect, it } from 'vitest'
import type {
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import { SshPtySourceObligationLedger } from './ssh-pty-source-obligation-ledger'

function identity(
  deliveryToken = 'token-1',
  overrides: Partial<PtySourceDeliveryIdentity> = {}
): PtySourceDeliveryIdentity {
  return {
    id: 'pty-1',
    providerGeneration: 1,
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken,
    ...overrides
  }
}

function span(
  owner: PtySourceDeliveryIdentity,
  spanId: string,
  sourceStartSu: number,
  data: string
): PtySourceSpan {
  return Object.freeze({
    ...owner,
    spanId,
    sourceStartSu,
    sourceEndSu: sourceStartSu + data.length,
    displayStart: sourceStartSu,
    displayEnd: sourceStartSu + data.length,
    data,
    splittable: true,
    transform: Object.freeze({
      transformed: false,
      rawLengthSu: data.length,
      scalarSafe: true
    })
  })
}

function commitSpan(
  ledger: SshPtySourceObligationLedger,
  owner: PtySourceDeliveryIdentity,
  sourceSpan: PtySourceSpan,
  consumers: ('model' | 'desktop')[] = ['model', 'desktop']
) {
  const reservation = ledger.reserve(owner, sourceSpan, consumers)
  ledger.commit(reservation)
  return reservation
}

describe('SshPtySourceObligationLedger', () => {
  it('rolls back an uncommitted admission without consuming its source coordinate', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    const first = ledger.reserve(owner, span(owner, 'span-1', 0, 'abc'), ['model'])

    expect(ledger.rollback(first)).toBe(true)
    const retry = ledger.reserve(owner, span(owner, 'span-2', 0, 'abc'), ['model'])
    ledger.commit(retry)
    expect(ledger.snapshot(owner).receivedEndSu).toBe(3)
  })

  it('rolls back a committed tail while every obligation is still open', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    const reservation = commitSpan(ledger, owner, span(owner, 'span-1', 0, 'abc'))

    expect(ledger.rollbackCommitted(reservation)).toBe(true)
    expect(ledger.snapshot(owner)).toMatchObject({ receivedEndSu: 0, openSpans: 0 })
    expect(() => ledger.spanIdentity('span-1')).toThrow('Unknown or reclaimed')
    expect(
      ledger.commit(ledger.reserve(owner, span(owner, 'span-2', 0, 'abc'), ['model']))
    ).toBeUndefined()
  })

  it('keeps terminal, queued, and successfully published ACK ends independent', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'span-1', 0, 'abcd'))

    ledger.settle('span-1', 'model', 'emulator-receipt')
    expect(ledger.snapshot(owner)).toMatchObject({
      obligationsTerminalEndSu: 0,
      ackQueuedEndSu: 0,
      ackPublishedEndSu: 0
    })
    ledger.settle('span-1', 'desktop', 'renderer-parse')
    expect(ledger.snapshot(owner)).toMatchObject({
      obligationsTerminalEndSu: 4,
      ackQueuedEndSu: 0,
      ackPublishedEndSu: 0
    })
    const publication = ledger.queueAck(owner)!
    expect(ledger.snapshot(owner)).toMatchObject({
      obligationsTerminalEndSu: 4,
      ackQueuedEndSu: 4,
      ackPublishedEndSu: 0
    })
    publication.onSettled({ ok: false, error: new Error('write callback failed') })
    expect(ledger.snapshot(owner)).toMatchObject({ ackQueuedEndSu: 4, ackPublishedEndSu: 0 })
    ledger.retryQueuedAck(owner)!.onSettled({ ok: true })
    expect(ledger.snapshot(owner)).toMatchObject({ ackPublishedEndSu: 4, openSpans: 0 })
  })

  it('checkpoints only the contiguous model-settled prefix', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'span-1', 0, 'abcd'))
    commitSpan(ledger, owner, span(owner, 'span-2', 4, 'efgh'))

    expect(ledger.modelAcceptedEnd(owner)).toBe(0)
    ledger.settle('span-2', 'model', 'out-of-order')
    expect(ledger.modelAcceptedEnd(owner)).toBe(0)
    ledger.settle('span-1', 'model', 'emulator-receipt')
    expect(ledger.modelAcceptedEnd(owner)).toBe(8)
  })

  it('continues checkpoints from the reclaimed ACK-published prefix', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'span-1', 0, 'abcd'))
    commitSpan(ledger, owner, span(owner, 'span-2', 4, 'efgh'))
    ledger.settle('span-1', 'model', 'emulator-receipt')
    ledger.settle('span-1', 'desktop', 'renderer-parse')
    ledger.queueAck(owner)!.onSettled({ ok: true })

    expect(ledger.snapshot(owner)).toMatchObject({ ackPublishedEndSu: 4, openSpans: 1 })
    expect(ledger.modelAcceptedEnd(owner)).toBe(4)
    ledger.settle('span-2', 'model', 'emulator-receipt')
    expect(ledger.modelAcceptedEnd(owner)).toBe(8)
  })

  it('requires an exact transfer fence before a desktop obligation becomes terminal', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'span-1', 0, 'abc'))
    ledger.settle('span-1', 'model', 'emulator-receipt')

    expect(ledger.beginTransfer('span-1', 'desktop', 'model', 'renderer-send-failed')).toBe(true)
    expect(ledger.snapshot(owner).obligationsTerminalEndSu).toBe(0)
    expect(ledger.commitTransfer('span-1', 'desktop')).toBe(true)
    expect(ledger.snapshot(owner).obligationsTerminalEndSu).toBe(3)
    expect(ledger.obligation('span-1', 'desktop')).toMatchObject({
      state: 'transferred',
      to: 'model'
    })
  })

  it('keeps sealed exit state until final ACK publication succeeds', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'tail', 0, 'tail'), ['model'])
    ledger.seal(owner)
    expect(() => ledger.markExitPublished(owner)).toThrow('terminal ACK')
    ledger.settle('tail', 'model', 'emulator-receipt')
    const publication = ledger.queueAck(owner)!
    ledger.markExitPublished(owner)
    expect(ledger.snapshot(owner).state).toBe('sealed-unsettled')
    publication.onSettled({ ok: true })
    expect(ledger.snapshot(owner).state).toBe('closed')
  })

  it('publishes token cancellation intent before accepting timeout cleanup proof', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'tail', 0, 'tail'), ['model'])
    ledger.seal(owner)

    expect(() => ledger.applyCancellationProof(owner, { sentEndSu: 4, creditedEndSu: 0 })).toThrow()
    expect(ledger.beginExitTimeout(owner)).toEqual({
      id: owner.id,
      deliveryToken: owner.deliveryToken,
      clientGeneration: owner.clientGeneration,
      ownerGeneration: owner.ownerGeneration
    })
    ledger.applyCancellationProof(owner, { sentEndSu: 4, creditedEndSu: 0 })
    expect(ledger.snapshot(owner)).toMatchObject({ state: 'closed', openSpans: 0 })
  })

  it('ignores a late successful write callback after generation-close proof', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'span-1', 0, 'abc'), ['model'])
    ledger.settle('span-1', 'model', 'accepted')
    const publication = ledger.queueAck(owner)!

    expect(ledger.closeGeneration(1, 'provider-closed')).toBe(1)
    publication.onSettled({ ok: true })
    expect(ledger.snapshot(owner)).toMatchObject({
      state: 'closed',
      generationClosed: true,
      ackPublishedEndSu: 0
    })
    expect(() => ledger.obligation('span-1', 'model')).toThrow('reclaimed')
  })

  it('rejects stale generations, tokens, and non-contiguous source spans', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    expect(() =>
      ledger.reserve(identity('stale'), span(identity('stale'), 'stale', 0, 'x'), ['model'])
    ).toThrow('stale')
    expect(() => ledger.reserve(owner, span(owner, 'gap', 1, 'x'), ['model'])).toThrow(
      'non-contiguous'
    )
  })

  it('requires cancellation proof to match the exact local received and published ends', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    commitSpan(ledger, owner, span(owner, 'tail', 0, 'tail'), ['model'])
    ledger.seal(owner)
    ledger.beginExitTimeout(owner)

    expect(() => ledger.applyCancellationProof(owner, { sentEndSu: 3, creditedEndSu: 0 })).toThrow(
      'invalid'
    )
    expect(() => ledger.applyCancellationProof(owner, { sentEndSu: 4, creditedEndSu: 1 })).toThrow(
      'invalid'
    )
  })

  it('applies recovery cancellation proof over a locally admitted prefix', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner, 4)
    commitSpan(ledger, owner, span(owner, 'recovery', 4, 'tail'), ['model'])

    ledger.applyRecoveryCancellationProof(owner, { sentEndSu: 12, creditedEndSu: 4 })

    expect(ledger.snapshot(owner)).toMatchObject({ state: 'closed', openSpans: 0 })
  })

  it('rejects recovery cancellation proof that misses local intake state', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner, 4)
    commitSpan(ledger, owner, span(owner, 'recovery', 4, 'tail'), ['model'])

    expect(() =>
      ledger.applyRecoveryCancellationProof(owner, { sentEndSu: 7, creditedEndSu: 4 })
    ).toThrow('invalid')
    expect(() =>
      ledger.applyRecoveryCancellationProof(owner, { sentEndSu: 8, creditedEndSu: 5 })
    ).toThrow('invalid')
  })

  it('bounds closed-token tombstones and removes committed reservation indexes', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owners = Array.from({ length: 300 }, (_, index) =>
      identity(`token-${index}`, {
        id: `pty-${index}`,
        ptyIncarnation: `incarnation-${index}`
      })
    )
    for (const [index, owner] of owners.entries()) {
      ledger.open(owner)
      commitSpan(ledger, owner, span(owner, `span-${index}`, 0, 'x'), ['model'])
      ledger.closeGeneration(1, 'generation-closed')
    }

    expect(() => ledger.snapshot(owners[0])).toThrow('stale')
    expect(ledger.snapshot(owners.at(-1)!)).toMatchObject({ state: 'closed' })
  })

  it('reclaims uncommitted reservations on exact cancellation proof', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    const reservation = ledger.reserve(owner, span(owner, 'pending', 0, 'x'), ['model'])
    ledger.seal(owner)
    ledger.beginExitTimeout(owner)

    ledger.applyCancellationProof(owner, { sentEndSu: 0, creditedEndSu: 0 })

    expect(ledger.rollback(reservation)).toBe(false)
    expect(ledger.snapshot(owner)).toMatchObject({ state: 'closed', openSpans: 0 })
  })

  it('rejects reopening a recently closed one-use token', () => {
    const ledger = new SshPtySourceObligationLedger()
    const owner = identity()
    ledger.open(owner)
    ledger.closeGeneration(owner.providerGeneration, 'closed')

    expect(() => ledger.open(owner)).toThrow('already used')
  })
})
