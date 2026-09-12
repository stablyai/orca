import { afterEach, expect, it, vi } from 'vitest'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'
const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
})

async function setup() {
  const fixture = await createSourceRetirementPublicationFixture()
  disposals.push(fixture.dispose)
  return fixture
}

it('retires one drained source delivery without exit or canceling sibling publication', async () => {
  const f = await setup()
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  const cleanup = f.prepare()
  const before = f.writes.length
  cleanup.remove(() => {})
  cleanup.remove(() => {})
  expect(cancel).toHaveBeenCalledOnce()
  expect(f.session.sourceDeliverySnapshotIfKnown(cleanup.delivery)?.state).toBe('closed')
  expect(f.publication.accepts('source')).toBe(false)
  expect(f.publication.ownershipTransfer.resolve('source')).toBeNull()
  expect(f.publication.accepts('other')).toBe(true)
  expect(f.publication.publish('other', { data: 'still live' }, false)).toBe(true)
  expect(f.writes.slice(before).some((frame) => frame.includes(Buffer.from('pty.exit')))).toBe(
    false
  )
})

it('refuses unacknowledged source output without canceling the delivery', async () => {
  const f = await setup()
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  f.publication.publish('source', { data: 'uncredited' }, false)
  expect(f.prepare).toThrow('drained_delivery_required')
  expect(cancel).not.toHaveBeenCalled()
  expect(f.publication.accepts('source')).toBe(true)
})

it('pins the original source identity instead of retaining mutable caller input', async () => {
  const f = await setup()
  const source = { ...f.source }
  const cleanup = f.publication.prepareOwnershipTransferRetirement(source, 1)
  source.terminalId = 'other'
  source.ownerLease = 'replacement'
  cleanup.remove(() => {})
  cleanup.assertRemoved()
  expect(f.publication.accepts('source')).toBe(false)
  expect(f.publication.accepts('other')).toBe(true)
})

it.each(['missing', 'active', 'cursor', 'token', 'window', 'exit', 'generation'])(
  'retains exact closed-ledger authority after publication removal: %s',
  async (mode) => {
    const f = await setup()
    const cleanup = f.prepare()
    cleanup.remove(() => {})
    const closed = f.session.sourceDeliverySnapshotIfKnown(cleanup.delivery)!
    const read = vi.spyOn(f.session, 'sourceDeliverySnapshotIfKnown').mockReturnValue(
      mode === 'missing'
        ? null
        : {
            ...closed,
            ...(mode === 'active' ? { state: 'active' as const } : {}),
            ...(mode === 'cursor' ? { creditedEndSu: closed.creditedEndSu + 1 } : {}),
            ...(mode === 'token' ? { deliveryToken: 'replacement' } : {}),
            ...(mode === 'window' ? { windowSu: closed.windowSu + 1 } : {}),
            ...(mode === 'exit' ? { exitPublished: true } : {}),
            ...(mode === 'generation' ? { generationClosed: true } : {})
          }
    )
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    expect(cleanup.assertCurrent).toThrow('closed_ledger_required')
    expect(cleanup.assertRemoved).toThrow('closed_ledger_required')
    expect(() => cleanup.remove(() => {})).toThrow('closed_ledger_required')
    expect(cancel).not.toHaveBeenCalled()
    read.mockRestore()
    cleanup.assertRemoved()
    cleanup.remove(() => {})
    expect(cancel).not.toHaveBeenCalled()
  }
)

it.each(['exact', 'missing-ledger', 'replacement'])(
  'reconstructs removed publication only with retained exact closed ledger: %s',
  async (mode) => {
    const f = await setup()
    const original = f.prepare()
    original.remove(() => {})
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    if (mode === 'missing-ledger') {
      vi.spyOn(f.session, 'sourceDeliverySnapshotIfKnown').mockReturnValue(null)
      expect(() =>
        f.publication.prepareOwnershipTransferRetirement(f.source, undefined, original.delivery)
      ).toThrow('closed_ledger_required')
      return
    }
    const recovered = f.publication.prepareOwnershipTransferRetirement(
      f.source,
      undefined,
      original.delivery
    )
    if (mode === 'replacement') {
      f.activate('source')
      expect(() => recovered.remove(() => {})).toThrow('absence_changed')
      expect(f.publication.accepts('source')).toBe(true)
    } else {
      expect(() =>
        recovered.remove(() => {
          throw new Error('authority lost')
        })
      ).toThrow('authority lost')
      recovered.remove(() => {})
      recovered.remove(() => {})
      expect(f.publication.accepts('source')).toBe(false)
    }
    expect(cancel).not.toHaveBeenCalled()
    expect(f.publication.accepts('other')).toBe(true)
  }
)

it.each(['exact', 'token', 'cursor', 'window'])(
  'reconstructs a cancelled delivery only against exact historical drainage: %s',
  async (mode) => {
    const f = await setup()
    const original = f.prepare()
    const expected = original.delivery
    expect(() =>
      original.remove(() => {
        if (f.session.sourceDeliverySnapshotIfKnown(expected)?.state === 'closed') {
          throw new Error('interrupted after cancellation')
        }
      })
    ).toThrow('interrupted after cancellation')
    expect(f.prepare).toThrow('drained_delivery_required')
    const changed = {
      ...expected,
      ...(mode === 'token' ? { deliveryToken: 'other' } : {}),
      ...(mode === 'cursor' ? { receivedEndSu: 1, sentEndSu: 1, creditedEndSu: 1 } : {}),
      ...(mode === 'window' ? { windowSu: expected.windowSu + 1 } : {})
    }
    const prepare = () => f.publication.prepareOwnershipTransferRetirement(f.source, 1, changed)
    if (mode === 'exact') {
      const recovered = prepare()
      expect(() =>
        recovered.remove(() => {
          throw new Error('authority lost')
        })
      ).toThrow('authority lost')
      expect(f.publication.accepts('source')).toBe(true)
      recovered.remove(() => {})
      expect(f.publication.accepts('source')).toBe(false)
    } else {
      expect(prepare).toThrow('drained_delivery_required')
      expect(f.publication.accepts('source')).toBe(true)
    }
    expect(f.publication.accepts('other')).toBe(true)
  }
)

it('revalidates output arriving after preparation before cancellation', async () => {
  const f = await setup()
  const cleanup = f.prepare()
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  f.publication.publish('source', { data: 'later output' }, false)
  expect(() => cleanup.remove(() => {})).toThrow('delivery_changed')
  expect(cancel).not.toHaveBeenCalled()
})

it('requires fresh authority before cancellation and before publication record removal', async () => {
  const f = await setup()
  const cleanup = f.prepare()
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  expect(() =>
    cleanup.remove(() => {
      throw new Error('authority lost')
    })
  ).toThrow('authority lost')
  expect(cancel).not.toHaveBeenCalled()
  expect(() =>
    cleanup.remove(() => {
      if (cancel.mock.calls.length) {
        throw new Error('authority lost')
      }
    })
  ).toThrow('authority lost')
  expect(f.publication.accepts('source')).toBe(true)
  cleanup.remove(() => {})
  expect(cancel).toHaveBeenCalledOnce()
  expect(f.publication.accepts('source')).toBe(false)
})

it.each(['before', 'after'] as const)(
  'retries cancellation failure %s ledger closure',
  async (when) => {
    const f = await setup()
    const cleanup = f.prepare()
    const original = f.session.cancelDelivery.bind(f.session)
    const cancel = vi.spyOn(f.session, 'cancelDelivery').mockImplementationOnce((...args) => {
      if (when === 'after') {
        original(...args)
      }
      throw new Error('cancellation failed')
    })
    expect(() => cleanup.remove(() => {})).toThrow('cancellation failed')
    expect(f.publication.accepts('source')).toBe(true)
    cleanup.remove(() => {})
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(f.publication.accepts('source')).toBe(false)
  }
)

it('refuses a replacement delivery on retry instead of canceling the new owner', async () => {
  const f = await setup()
  const cleanup = f.prepare()
  cleanup.remove(() => {})
  f.activate('source')
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  expect(() => cleanup.remove(() => {})).toThrow('delivery_changed')
  expect(cancel).not.toHaveBeenCalled()
  expect(f.publication.accepts('source')).toBe(true)
})

it.each([false, true])(
  'source disconnect alone cannot authorize retirement even when output is credited: %s',
  async (credited) => {
    const f = await setup()
    const original = f.prepare().delivery
    f.publication.publish('source', { data: 'retained' }, false)
    if (credited) {
      await f.acknowledge('source', 8)
    }
    const before = f.session.sourceDeliverySnapshotIfKnown(original)!
    expect(before.receivedEndSu).toBe(8)
    expect(before.creditedEndSu).toBe(credited ? 8 : 0)
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    f.detachOwner()
    expect(f.publication.ownershipTransfer.resolve('source')).toBeNull()
    expect(() => f.publication.prepareOwnershipTransferRetirement(f.source, 1, before)).toThrow(
      'drained_delivery_required'
    )
    expect(cancel).not.toHaveBeenCalled()
    expect(f.session.sourceDeliverySnapshotIfKnown(original)).toMatchObject({
      state: 'active',
      receivedEndSu: 8,
      creditedEndSu: credited ? 8 : 0
    })
  }
)
