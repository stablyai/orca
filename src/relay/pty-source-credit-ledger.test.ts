import { describe, expect, it } from 'vitest'
import {
  ptySourceDeliveryKey,
  type PtySourceDeliveryIdentity
} from '../shared/pty-source-credit-contract'
import { RelayPtySourceCreditLedger } from './pty-source-credit-ledger'
import { CLOSED_DELIVERY_TOMBSTONE_LIMIT, type DeliveryRecord } from './pty-source-credit-record'

function getDeliveryRecord(
  ledger: RelayPtySourceCreditLedger,
  owner: PtySourceDeliveryIdentity
): DeliveryRecord {
  const internals = ledger as unknown as { deliveries: Map<string, DeliveryRecord> }
  const record = internals.deliveries.get(ptySourceDeliveryKey(owner))
  if (!record) {
    throw new Error('test delivery record missing')
  }
  return record
}

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

function append(
  ledger: RelayPtySourceCreditLedger,
  owner: PtySourceDeliveryIdentity,
  data: string,
  spanId = `span-${data}`
): void {
  const start = ledger.snapshot(owner).receivedEndSu
  ledger.append(owner, {
    spanId,
    data,
    displayStart: start,
    displayEnd: start + data.length,
    splittable: true,
    transform: {
      transformed: false,
      rawLengthSu: data.length,
      scalarSafe: true
    }
  })
}

function drainOne(
  ledger: RelayPtySourceCreditLedger,
  owner: PtySourceDeliveryIdentity,
  maxSourceSu = 16 * 1024
) {
  const reservation = ledger.reserveNextSend(owner, maxSourceSu)
  if (reservation) {
    ledger.commitSend(reservation)
  }
  return reservation
}

// Why: retention totals are maintained incrementally, so recomputing from the live records is
// the only independent check that no mutation path skipped a counter update.
function expectRetentionMatchesRecords(ledger: RelayPtySourceCreditLedger): void {
  const internals = ledger as unknown as { deliveries: Map<string, DeliveryRecord> }
  const expected = { sourceSu: 0, dataBytes: 0, spans: 0 }
  for (const record of internals.deliveries.values()) {
    expected.sourceSu += record.receivedEndSu - record.creditedEndSu
    expected.dataBytes += record.retainedDataBytes
    expected.spans += record.spans.length
  }
  expect(ledger.retentionSnapshot()).toEqual(expected)
}

describe('RelayPtySourceCreditLedger', () => {
  it('keeps send-span lookup near-linear across a retained-frame burst', () => {
    const spanCount = 1_024
    const ledger = new RelayPtySourceCreditLedger({
      maxRetainedSourceSu: spanCount * 2,
      maxAggregateRetainedSourceSu: spanCount * 2,
      maxRetainedDataBytes: spanCount * 1_024,
      maxAggregateRetainedDataBytes: spanCount * 1_024,
      maxRetainedSpans: spanCount,
      maxAggregateRetainedSpans: spanCount
    })
    const owner = identity()
    ledger.open(owner, spanCount * 2)
    for (let index = 0; index < spanCount; index += 1) {
      append(ledger, owner, 'x', `span-${index}`)
    }

    const record = getDeliveryRecord(ledger, owner)
    let indexedReads = 0
    const spans = record.spans
    record.spans = new Proxy(spans, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          indexedReads += 1
        }
        return Reflect.get(target, property, receiver)
      }
    })

    let sends = 0
    while (true) {
      const reservation = ledger.reserveNextSend(owner, 1)
      if (!reservation) {
        break
      }
      ledger.commitSend(reservation)
      sends += 1
    }

    expect(sends).toBe(spanCount)
    // The final span remains the cursor until another source append arrives.
    expect(record.sendSpanIndex).toBe(spanCount - 1)
    // Linear in spans; the removed Array.find rescanned the sent prefix (524,800 predicate visits).
    expect(indexedReads).toBeLessThan(spanCount * 3)
  })

  it('keeps the uncovered-cursor diagnostic when a retained span has a gap', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity('token-gap')
    ledger.open(owner, 8)
    append(ledger, owner, 'ab', 'span-gap')
    const record = getDeliveryRecord(ledger, owner)
    record.spans = [
      Object.freeze({
        ...record.spans[0],
        sourceStartSu: 2,
        sourceEndSu: 4,
        transform: Object.freeze({ ...record.spans[0].transform, rawLengthSu: 2 })
      })
    ]

    expect(() => ledger.reserveNextSend(owner, 2)).toThrow(
      'PTY source delivery cursor is not covered by the retained ledger'
    )
  })

  it('keeps the cursor correct across ACK reclaim, rollback, rotation, and close', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const oldOwner = identity()
    const replacement = identity('token-replacement', {
      clientGeneration: 4,
      ownerGeneration: 5
    })
    ledger.open(oldOwner, 16)
    append(ledger, oldOwner, 'ab', 'span-a')
    append(ledger, oldOwner, 'cd', 'span-b')
    append(ledger, oldOwner, 'ef', 'span-c')

    const first = ledger.reserveNextSend(oldOwner, 2)!
    ledger.commitSend(first)
    expect(getDeliveryRecord(ledger, oldOwner).sendSpanIndex).toBe(0)
    ledger.acknowledge(oldOwner, {
      id: oldOwner.id,
      clientGeneration: oldOwner.clientGeneration,
      ownerGeneration: oldOwner.ownerGeneration,
      deliveryToken: oldOwner.deliveryToken,
      creditedEndSu: 2
    })
    expect(getDeliveryRecord(ledger, oldOwner).sendSpanIndex).toBe(0)

    const attempted = ledger.reserveNextSend(oldOwner, 1)!
    expect(attempted.span.data).toBe('c')
    ledger.rollbackSend(attempted)
    const retried = ledger.reserveNextSend(oldOwner, 1)!
    expect(retried.span.data).toBe('c')
    ledger.commitSend(retried)

    ledger.commitSend(ledger.reserveNextSend(oldOwner, 2)!)
    const rotation = ledger.rotate(oldOwner, replacement, 2, 16)
    expect(rotation.recovery.map((span) => span.data).join('')).toBe('cdef')
    expect(getDeliveryRecord(ledger, replacement).sendSpanIndex).toBe(0)
    // Rotation is the only path that removes and re-adds a record in one call.
    expectRetentionMatchesRecords(ledger)
    ledger.commitSend(ledger.reserveNextSend(replacement, 16)!)
    ledger.commitSend(ledger.reserveNextSend(replacement, 16)!)
    ledger.seal(replacement)
    ledger.settleExitPublication(replacement, { ok: true })
    ledger.acknowledge(replacement, {
      id: replacement.id,
      clientGeneration: replacement.clientGeneration,
      ownerGeneration: replacement.ownerGeneration,
      deliveryToken: replacement.deliveryToken,
      creditedEndSu: 6
    })
    expect(ledger.snapshotIfKnown(replacement)?.state).toBe('closed')

    expectRetentionMatchesRecords(ledger)

    const canceled = identity('token-canceled')
    ledger.open(canceled, 8)
    append(ledger, canceled, 'x', 'span-cancel')
    expectRetentionMatchesRecords(ledger)
    ledger.cancel(canceled, 'test-close')
    expect(ledger.snapshotIfKnown(canceled)?.state).toBe('closed')
    expectRetentionMatchesRecords(ledger)
    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 0, dataBytes: 0, spans: 0 })
  })

  it('rebases the send cursor when ACK reclaim removes spans at or past it', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity('token-reclaim')
    ledger.open(owner, 16)
    append(ledger, owner, 'ab', 'span-a')
    append(ledger, owner, 'cd', 'span-b')
    append(ledger, owner, 'ef', 'span-c')
    ledger.commitSend(ledger.reserveNextSend(owner, 2)!)
    ledger.commitSend(ledger.reserveNextSend(owner, 2)!)
    expect(getDeliveryRecord(ledger, owner).sendSpanIndex).toBe(1)

    ledger.acknowledge(owner, {
      id: owner.id,
      clientGeneration: owner.clientGeneration,
      ownerGeneration: owner.ownerGeneration,
      deliveryToken: owner.deliveryToken,
      creditedEndSu: 4
    })

    // Reclaim dropped both spans the cursor had passed, so it must rebase onto the new head.
    const record = getDeliveryRecord(ledger, owner)
    expect(record.spans.map((span) => span.data)).toEqual(['ef'])
    expect(record.sendSpanIndex).toBe(0)
    expect(ledger.reserveNextSend(owner, 2)!.span.data).toBe('ef')
  })

  it('reclaims every credited boundary across a long sequential ACK drain', () => {
    const boundaryCount = 1_024
    const spanCount = boundaryCount - 1
    const ledger = new RelayPtySourceCreditLedger({
      maxRetainedSpans: boundaryCount,
      maxAggregateRetainedSpans: boundaryCount
    })
    const owner = identity()
    ledger.open(owner, boundaryCount)
    for (let index = 0; index < spanCount; index += 1) {
      append(ledger, owner, 'x', `span-${index}`)
      const reservation = ledger.reserveNextSend(owner, 1)
      expect(reservation).not.toBeNull()
      ledger.commitSend(reservation!)
    }

    const record = getDeliveryRecord(ledger, owner)
    expect([...record.sentBoundaries]).toEqual(
      Array.from({ length: boundaryCount }, (_, index) => index)
    )

    for (let creditedEndSu = 1; creditedEndSu <= spanCount; creditedEndSu += 1) {
      expect(
        ledger.acknowledge(owner, {
          id: owner.id,
          clientGeneration: owner.clientGeneration,
          ownerGeneration: owner.ownerGeneration,
          deliveryToken: owner.deliveryToken,
          creditedEndSu
        })
      ).toBe('advanced')
      // Every boundary below the credit must be gone, so the oldest live one is the credit itself.
      const [oldestLive] = record.sentBoundaries
      expect(oldestLive).toBe(creditedEndSu)
      // Boundary cleanup and span reclamation must stay in step on every ACK, not just the last.
      expect(ledger.retentionSnapshot().spans).toBe(spanCount - creditedEndSu)
    }

    expect([...record.sentBoundaries]).toEqual([spanCount])
    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 0, dataBytes: 0, spans: 0 })
  })

  it('deletes every boundary skipped by a jump-ahead cumulative ACK', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 16)
    append(ledger, owner, 'abcdefgh')
    for (let index = 0; index < 8; index += 1) {
      ledger.commitSend(ledger.reserveNextSend(owner, 1)!)
    }
    const record = getDeliveryRecord(ledger, owner)
    expect([...record.sentBoundaries]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])

    expect(
      ledger.acknowledge(owner, {
        id: owner.id,
        clientGeneration: owner.clientGeneration,
        ownerGeneration: owner.ownerGeneration,
        deliveryToken: owner.deliveryToken,
        creditedEndSu: 8
      })
    ).toBe('advanced')
    expect([...record.sentBoundaries]).toEqual([8])
  })

  it('never exceeds a token source window across generated send/ACK sequences', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const ledger = new RelayPtySourceCreditLedger()
      const owner = identity(`token-${seed}`)
      const windowSu = 7 + (seed % 17)
      ledger.open(owner, windowSu)
      for (let part = 0; part < 20; part += 1) {
        append(ledger, owner, 'x'.repeat(5), `span-${seed}-${part}`)
      }

      for (let turn = 0; turn < 100; turn++) {
        const reservation = drainOne(ledger, owner, 1 + ((seed * 13 + turn * 7) % 19))
        const snapshot = ledger.snapshot(owner)
        expect(snapshot.sentEndSu - snapshot.creditedEndSu).toBeLessThanOrEqual(windowSu)
        const record = getDeliveryRecord(ledger, owner)
        const containingIndex = record.spans.findIndex(
          (span) =>
            span.sourceStartSu <= snapshot.sentEndSu && span.sourceEndSu > snapshot.sentEndSu
        )
        // Cursor may lag (advancement is lazy) but must never overshoot the containing span.
        if (containingIndex !== -1) {
          expect(record.sendSpanIndex).toBeLessThanOrEqual(containingIndex)
        }
        if (snapshot.sentEndSu > snapshot.creditedEndSu && (turn + seed) % 3 === 0) {
          ledger.acknowledge(owner, {
            id: owner.id,
            clientGeneration: owner.clientGeneration,
            ownerGeneration: owner.ownerGeneration,
            deliveryToken: owner.deliveryToken,
            creditedEndSu: snapshot.sentEndSu
          })
        }
        expectRetentionMatchesRecords(ledger)
        if (!reservation && snapshot.creditedEndSu === 100) {
          break
        }
      }
    }
  })

  it('slices splittable source without splitting a surrogate pair', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 3)
    append(ledger, owner, `a😀b`)

    expect(drainOne(ledger, owner, 2)?.span.data).toBe('a')
    ledger.acknowledge(owner, {
      id: owner.id,
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: owner.deliveryToken,
      creditedEndSu: 1
    })
    expect(drainOne(ledger, owner, 2)?.span.data).toBe('😀')
  })

  it('never emits the leading half of a surrogate pair', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 1)
    append(ledger, owner, `😀`)

    expect(() => drainOne(ledger, owner, 1)).toThrow('surrogate pair')
    expect(ledger.snapshot(owner)).toMatchObject({ sentEndSu: 0, creditedEndSu: 0 })
  })

  it('holds an indivisible transform that does not fit the remaining window', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 4, 2)
    ledger.append(owner, {
      spanId: 'transform',
      data: 'Z',
      displayStart: 0,
      displayEnd: 1,
      splittable: false,
      transform: { transformed: true, rawLengthSu: 5, scalarSafe: true }
    })

    expect(ledger.reserveNextSend(owner)).toBeNull()
    expect(ledger.snapshot(owner)).toMatchObject({ sentEndSu: 2, creditedEndSu: 2 })
  })

  it('rejects wrong owners, stale tokens, and over-credit without clamping', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 16)
    append(ledger, owner, 'abcd')
    drainOne(ledger, owner)

    expect(() =>
      ledger.acknowledge(owner, {
        id: owner.id,
        clientGeneration: 99,
        ownerGeneration: owner.ownerGeneration,
        deliveryToken: owner.deliveryToken,
        creditedEndSu: 1
      })
    ).toThrow('does not own')
    expect(() =>
      ledger.acknowledge(owner, {
        id: owner.id,
        clientGeneration: owner.clientGeneration,
        ownerGeneration: owner.ownerGeneration,
        deliveryToken: owner.deliveryToken,
        creditedEndSu: 5
      })
    ).toThrow('exceeds sent')
    expect(() => ledger.snapshot(identity('stale'))).toThrow('stale')
  })

  it('rejects cumulative ACKs inside a committed frame boundary', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 16)
    append(ledger, owner, 'abcd')
    drainOne(ledger, owner)

    expect(() =>
      ledger.acknowledge(owner, {
        id: owner.id,
        clientGeneration: 2,
        ownerGeneration: 3,
        deliveryToken: owner.deliveryToken,
        creditedEndSu: 2
      })
    ).toThrow('boundary')
    expect(ledger.snapshot(owner).creditedEndSu).toBe(0)
  })

  it('reserves an exact early ACK until the matching send settles', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 4)
    append(ledger, owner, 'data')
    const pending = ledger.reserveNextSend(owner)!

    expect(
      ledger.acknowledge(owner, {
        id: owner.id,
        clientGeneration: owner.clientGeneration,
        ownerGeneration: owner.ownerGeneration,
        deliveryToken: owner.deliveryToken,
        creditedEndSu: 4
      })
    ).toBe('reserved')
    expect(ledger.snapshot(owner)).toMatchObject({ sentEndSu: 0, creditedEndSu: 0 })

    ledger.commitSend(pending)
    expect(ledger.snapshot(owner)).toMatchObject({ sentEndSu: 4, creditedEndSu: 4 })
    expect([...getDeliveryRecord(ledger, owner).sentBoundaries]).toEqual([4])
    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 0, dataBytes: 0, spans: 0 })
  })

  it('retains reserved credit across an exact same-token send retry', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 4)
    append(ledger, owner, 'data')
    const failed = ledger.reserveNextSend(owner)!
    ledger.acknowledge(owner, {
      id: owner.id,
      clientGeneration: owner.clientGeneration,
      ownerGeneration: owner.ownerGeneration,
      deliveryToken: owner.deliveryToken,
      creditedEndSu: 4
    })

    ledger.rollbackSend(failed)
    expect(
      ledger.acknowledge(owner, {
        id: owner.id,
        clientGeneration: owner.clientGeneration,
        ownerGeneration: owner.ownerGeneration,
        deliveryToken: owner.deliveryToken,
        creditedEndSu: 4
      })
    ).toBe('reserved')
    expect(ledger.reserveNextSend(owner, 3)).toBeNull()
    const retry = ledger.reserveNextSend(owner)!
    ledger.commitSend(retry)

    expect(ledger.snapshot(owner)).toMatchObject({ sentEndSu: 4, creditedEndSu: 4 })
    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 0, dataBytes: 0, spans: 0 })
  })

  it('keeps sealed-unsettled state until exit and suffix ACK are both published', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 8)
    append(ledger, owner, 'tail')
    drainOne(ledger, owner)
    ledger.seal(owner)
    ledger.settleExitPublication(owner, { ok: true })

    expect(ledger.snapshot(owner).state).toBe('sealed-unsettled')
    ledger.acknowledge(owner, {
      id: owner.id,
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: owner.deliveryToken,
      creditedEndSu: 4
    })
    expect(ledger.snapshot(owner).state).toBe('closed')
  })

  it('cannot publish exit while a preceding source span is unsent or reserved', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 8)
    append(ledger, owner, 'tail')
    ledger.seal(owner)

    expect(() => ledger.settleExitPublication(owner, { ok: true })).toThrow('preceding')
  })

  it('rotates tokens with exact recovery and rejects the stale delivery', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const oldOwner = identity()
    const replacement = identity('token-2', {
      clientGeneration: 4,
      ownerGeneration: 5
    })
    ledger.open(oldOwner, 16)
    append(ledger, oldOwner, 'abcdefgh')
    drainOne(ledger, oldOwner, 3)
    ledger.acknowledge(oldOwner, {
      id: oldOwner.id,
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: oldOwner.deliveryToken,
      creditedEndSu: 3
    })
    drainOne(ledger, oldOwner, 2)

    const rotation = ledger.rotate(oldOwner, replacement, 5, 16)
    expect(rotation.recovery.map((span) => span.data).join('')).toBe('fgh')
    expect(rotation.cancellation).toMatchObject({
      remainingStartSu: 3,
      remainingEndSu: 5,
      replacementDeliveryToken: 'token-2'
    })
    expect(() =>
      ledger.acknowledge(oldOwner, {
        id: oldOwner.id,
        clientGeneration: 2,
        ownerGeneration: 3,
        deliveryToken: oldOwner.deliveryToken,
        creditedEndSu: 8
      })
    ).toThrow()
    expect(() =>
      ledger.open(identity('token-3', { clientGeneration: 6, ownerGeneration: 7 }), 16)
    ).toThrow('upstream owner')
  })

  it('rejects non-boundary and pending-send recovery with zero mutation', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const oldOwner = identity()
    const replacement = identity('token-2', {
      clientGeneration: 4,
      ownerGeneration: 5
    })
    ledger.open(oldOwner, 16)
    append(ledger, oldOwner, 'abcdefgh')
    drainOne(ledger, oldOwner, 4)
    const before = ledger.snapshot(oldOwner)

    expect(() => ledger.rotate(oldOwner, replacement, 3, 16)).toThrow('checkpoint')
    expect(ledger.snapshot(oldOwner)).toEqual(before)

    const pending = ledger.reserveNextSend(oldOwner, 2)!
    expect(() => ledger.rotate(oldOwner, replacement, 4, 16)).toThrow('checkpoint')
    expect(ledger.snapshot(oldOwner)).toEqual(before)
    ledger.rollbackSend(pending)
    expect(ledger.snapshot(oldOwner)).toEqual(before)
  })

  it('rejects a recovery checkpoint beyond source accepted by the sink', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const oldOwner = identity()
    const replacement = identity('token-2', {
      clientGeneration: 4,
      ownerGeneration: 5
    })
    ledger.open(oldOwner, 16)
    append(ledger, oldOwner, 'abcdefgh')
    drainOne(ledger, oldOwner, 4)

    expect(() => ledger.rotate(oldOwner, replacement, 8, 16)).toThrow('checkpoint')
    expect(ledger.snapshot(oldOwner)).toMatchObject({
      state: 'active',
      receivedEndSu: 8,
      sentEndSu: 4
    })
  })

  it('accepts an exact receiver checkpoint for a rolled-back send attempt', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const oldOwner = identity()
    const replacement = identity('token-2', {
      clientGeneration: 4,
      ownerGeneration: 5
    })
    ledger.open(oldOwner, 16)
    append(ledger, oldOwner, 'abcdefgh')
    const attempted = ledger.reserveNextSend(oldOwner, 4)!
    ledger.rollbackSend(attempted)

    const rotation = ledger.rotate(oldOwner, replacement, 4, 16)

    expect(rotation.recovery.map((span) => span.data).join('')).toBe('efgh')
    expect(rotation.cancellation).toMatchObject({ sentEndSu: 4, creditedEndSu: 0 })
    expect(ledger.snapshot(replacement)).toMatchObject({
      receivedEndSu: 8,
      sentEndSu: 4,
      creditedEndSu: 4
    })
  })

  it('generation-closes every retained token exactly once', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 8)
    append(ledger, owner, 'data')

    expect(ledger.closeGeneration(1)).toBe(1)
    expect(ledger.closeGeneration(1)).toBe(0)
    expect(ledger.snapshot(owner)).toMatchObject({ state: 'closed', generationClosed: true })
    expect(ledger.retainedSourceSu()).toBe(0)
  })

  it('enforces an aggregate retained-source budget across PTYs', () => {
    const ledger = new RelayPtySourceCreditLedger({
      maxRetainedSourceSu: 8,
      maxAggregateRetainedSourceSu: 6
    })
    const first = identity('token-a')
    const second = identity('token-b', {
      id: 'pty-2',
      ptyIncarnation: 'incarnation-2'
    })
    ledger.open(first, 8)
    ledger.open(second, 8)
    append(ledger, first, 'abcd')

    expect(() => append(ledger, second, 'xyz')).toThrow('Aggregate')
    expect(ledger.retainedSourceSu()).toBe(4)
  })

  it('bounds exact UTF-8 retained bytes for transformed spans', () => {
    const ledger = new RelayPtySourceCreditLedger({
      maxRetainedDataBytes: 7,
      maxAggregateRetainedDataBytes: 7
    })
    const owner = identity()
    ledger.open(owner, 8)

    expect(() =>
      ledger.append(owner, {
        spanId: 'expanded',
        data: '😀😀',
        displayStart: 0,
        displayEnd: 4,
        splittable: false,
        transform: { transformed: true, rawLengthSu: 1, scalarSafe: false }
      })
    ).toThrow('encoded-data')
    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 0, dataBytes: 0, spans: 0 })
  })

  it('charges UTF-16 storage and one record per retained source frame', () => {
    const ledger = new RelayPtySourceCreditLedger({
      maxRetainedDataBytes: 391,
      maxAggregateRetainedDataBytes: 391
    })
    const owner = identity()
    ledger.open(owner, 8)
    append(ledger, owner, '\u0000'.repeat(64), 'utf16-heavy')

    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 64, dataBytes: 256, spans: 1 })
    expect(() => append(ledger, owner, 'a'.repeat(8), 'fragment')).toThrow('retained encoded-data')
    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 64, dataBytes: 256, spans: 1 })
  })

  it('enforces per-PTY and aggregate source, charged-byte, and frame caps across fragments', () => {
    const limits = {
      maxRetainedSourceSu: 6,
      maxAggregateRetainedSourceSu: 9,
      maxRetainedDataBytes: 500,
      maxAggregateRetainedDataBytes: 700,
      maxRetainedSpans: 2,
      maxAggregateRetainedSpans: 3
    }
    const first = identity('token-a')
    const second = identity('token-b', {
      id: 'pty-2',
      ptyIncarnation: 'incarnation-2'
    })
    const ledger = new RelayPtySourceCreditLedger(limits)
    ledger.open(first, 8)
    ledger.open(second, 8)
    append(ledger, first, 'aa', 'first-a')
    append(ledger, first, 'bb', 'first-b')
    append(ledger, second, 'cc', 'second-a')

    expect(ledger.retentionSnapshot()).toEqual({
      sourceSu: 6,
      dataBytes: 396,
      spans: 3
    })
    expect(() => append(ledger, first, 'c', 'first-frame-cap')).toThrow('retained-span')
    expect(() => append(ledger, second, 'dddd', 'aggregate-source-cap')).toThrow('Aggregate')

    const byteLimited = new RelayPtySourceCreditLedger({
      ...limits,
      maxRetainedSourceSu: 200,
      maxAggregateRetainedSourceSu: 300,
      maxAggregateRetainedSpans: 10,
      maxRetainedSpans: 10,
      maxAggregateRetainedDataBytes: 650
    })
    byteLimited.open(first, 8)
    byteLimited.open(second, 8)
    append(byteLimited, first, '\u0000'.repeat(64), 'first-utf16')
    append(byteLimited, second, '\u0000'.repeat(64), 'second-utf16')
    expect(() => append(byteLimited, second, '\u0000'.repeat(8), 'aggregate-byte-cap')).toThrow(
      'Aggregate'
    )
  })

  it('bounds retained frame metadata independently of source units', () => {
    const ledger = new RelayPtySourceCreditLedger({
      maxRetainedSpans: 2,
      maxAggregateRetainedSpans: 2
    })
    const owner = identity()
    ledger.open(owner, 8)
    append(ledger, owner, 'a', 'span-a')
    append(ledger, owner, 'b', 'span-b')

    expect(() => append(ledger, owner, 'c', 'span-c')).toThrow('retained-span')
    expect(ledger.retentionSnapshot()).toEqual({ sourceSu: 2, dataBytes: 260, spans: 2 })
  })

  it('bounds closed token tombstones', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owners = Array.from({ length: 300 }, (_, index) =>
      identity(`token-${index}`, {
        id: `pty-${index}`,
        ptyIncarnation: `incarnation-${index}`
      })
    )
    for (const owner of owners) {
      ledger.open(owner, 8)
      ledger.cancel(owner, 'test')
    }

    expect(() => ledger.snapshot(owners[0])).toThrow('stale')
    expect(ledger.snapshot(owners.at(-1)!)).toMatchObject({ state: 'closed' })
  })

  it('probes live, closed, cancelled and evicted deliveries without throwing', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const live = identity('token-live', { id: 'pty-live' })
    ledger.open(live, 8)
    expect(ledger.snapshotIfKnown(live)).toMatchObject({ state: 'active', exitPublished: false })

    const completed = identity('token-completed', { id: 'pty-completed' })
    ledger.open(completed, 8)
    ledger.seal(completed)
    ledger.settleExitPublication(completed, { ok: true })
    expect(ledger.snapshotIfKnown(completed)).toMatchObject({
      state: 'closed',
      exitPublished: true
    })

    const canceled = identity('token-canceled', { id: 'pty-canceled' })
    ledger.open(canceled, 8)
    ledger.cancel(canceled, 'client-request')
    expect(ledger.snapshotIfKnown(canceled)).toMatchObject({
      state: 'closed',
      exitPublished: false
    })

    expect(ledger.snapshotIfKnown(identity('token-unknown'))).toBeNull()
    expect(() => ledger.snapshot(identity('token-unknown'))).toThrow('stale')

    for (let index = 0; index < CLOSED_DELIVERY_TOMBSTONE_LIMIT; index++) {
      const evicting = identity(`token-evicting-${index}`, { id: `pty-evicting-${index}` })
      ledger.open(evicting, 8)
      ledger.cancel(evicting, 'test')
    }
    expect(ledger.snapshotIfKnown(canceled)).toBeNull()
  })

  it('rejects reopening a recently closed one-use token', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const owner = identity()
    ledger.open(owner, 8)
    ledger.cancel(owner, 'test')

    expect(() => ledger.open(owner, 8)).toThrow('already used')
  })
})
