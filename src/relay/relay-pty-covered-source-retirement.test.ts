import { afterEach, expect, it, vi } from 'vitest'
import { prepareRelayPtyCoveredSourceRetirement } from './relay-pty-source-delivery-retirement'
import type { retainRelayPtyCommittedSourceCustody } from './relay-pty-committed-source-custody'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'

const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
  vi.restoreAllMocks()
})

async function setup(length = 8) {
  const f = await createSourceRetirementPublicationFixture()
  disposals.push(f.dispose)
  const original = f.prepare().delivery
  f.publication.publish('source', { data: 'x'.repeat(length) }, false)
  await new Promise((resolve) => setImmediate(resolve))
  const actual = f.session.sourceDeliverySnapshotIfKnown(original)!
  const { clientId } = await f.resumeOwner()
  const generation = f.session.activeSessionOwner(clientId)!.ownerGeneration
  // White-box transaction seam; the real publication, resolver, session and ledger remain intact.
  const deliveries = (
    f.publication as unknown as { deliveries: Map<string, RelayPtySourceDeliveryRecord> }
  ).deliveries
  let custodyAvailable = true
  // Durable custody validation is tested separately; this fixture supplies only its authority seam.
  const custody = {
    identity: f.source,
    delivery: actual,
    assertCurrent: () => {
      if (!custodyAvailable) {
        throw new Error('custody lost')
      }
    }
  } as ReturnType<typeof retainRelayPtyCommittedSourceCustody>
  const prepare = () =>
    prepareRelayPtyCoveredSourceRetirement(
      deliveries,
      f.session,
      f.publication.ownershipTransfer,
      custody,
      clientId,
      generation
    )
  const revokeSuccessor = () => vi.spyOn(f.session, 'activeSessionOwner').mockReturnValue(null)
  return {
    ...f,
    actual,
    custody,
    clientId,
    deliveries,
    prepare,
    revokeSuccessor,
    revokeCustody: () => {
      custodyAvailable = false
    },
    restoreCustody: () => {
      custodyAvailable = true
    }
  }
}

it('rejects the historical owner generation even when the lookup claims it is current', async () => {
  const f = await setup()
  const owner = f.session.activeSessionOwner(f.clientId)!
  vi.spyOn(f.session, 'activeSessionOwner').mockReturnValue({
    ...owner,
    ownerGeneration: f.source.sourceOwnerGeneration
  })
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  expect(() =>
    prepareRelayPtyCoveredSourceRetirement(
      f.deliveries,
      f.session,
      f.publication.ownershipTransfer,
      f.custody,
      f.clientId,
      f.source.sourceOwnerGeneration
    )
  ).toThrow('successor_unavailable')
  expect(cancel).not.toHaveBeenCalled()
})

it('requires the exact successor generation after cancellation, not merely a newer owner', async () => {
  const f = await setup()
  const cleanup = f.prepare()
  const owner = f.session.activeSessionOwner(f.clientId)!
  const original = f.session.cancelDelivery.bind(f.session)
  const cancel = vi.spyOn(f.session, 'cancelDelivery').mockImplementationOnce((...args) => {
    original(...args)
    vi.spyOn(f.session, 'activeSessionOwner').mockReturnValue({
      ...owner,
      ownerGeneration: owner.ownerGeneration + 1
    })
  })
  expect(() => cleanup.remove(() => {})).toThrow('successor_unavailable')
  expect(f.deliveries.has('source')).toBe(true)
  expect(f.prepare).toThrow('successor_unavailable')
  expect(cancel).toHaveBeenCalledOnce()
})

it.each([8, 300])(
  'retires %s retained units without fabricating credit or disturbing siblings',
  async (length) => {
    const f = await setup(length)
    const sibling = f.deliveries.get('other')
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    const cleanup = f.prepare()
    expect(cleanup.delivery).toMatchObject({
      receivedEndSu: length,
      sentEndSu: Math.min(length, 256),
      creditedEndSu: 0
    })
    cleanup.remove(() => {})
    cleanup.remove(() => {})
    cleanup.assertRemoved()
    expect(cancel).toHaveBeenCalledOnce()
    expect(f.session.sourceDeliverySnapshotIfKnown(f.actual)).toEqual({
      ...f.actual,
      state: 'closed'
    })
    expect(f.deliveries.has('source')).toBe(false)
    expect(f.deliveries.get('other')).toBe(sibling)
    expect(f.publication.accepts('other')).toBe(true)
  }
)

it.each(['successor', 'custody'])('refuses %s loss before cancellation', async (authority) => {
  const f = await setup()
  const cleanup = f.prepare()
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  if (authority === 'successor') {
    f.revokeSuccessor()
  } else {
    f.revokeCustody()
  }
  expect(() => cleanup.remove(() => {})).toThrow()
  expect(cancel).not.toHaveBeenCalled()
  expect(f.session.sourceDeliverySnapshotIfKnown(f.actual)).toEqual(f.actual)
})

it.each(['successor', 'custody'])(
  'preserves a closed publication for retry on %s loss during cancellation',
  async (authority) => {
    const f = await setup()
    const cleanup = f.prepare()
    const originalCancel = f.session.cancelDelivery.bind(f.session)
    let restore = () => {}
    const cancel = vi.spyOn(f.session, 'cancelDelivery').mockImplementationOnce((...args) => {
      originalCancel(...args)
      if (authority === 'successor') {
        const spy = f.revokeSuccessor()
        restore = () => spy.mockRestore()
      } else {
        f.revokeCustody()
        restore = f.restoreCustody
      }
    })
    expect(() => cleanup.remove(() => {})).toThrow()
    expect(f.deliveries.has('source')).toBe(true)
    expect(f.session.sourceDeliverySnapshotIfKnown(f.actual)).toEqual({
      ...f.actual,
      state: 'closed'
    })
    expect(f.prepare).toThrow()
    restore()
    cleanup.remove(() => {})
    expect(cancel).toHaveBeenCalledOnce()
    expect(f.deliveries.has('source')).toBe(false)
  }
)

it.each(['closed', 'absent'])(
  'reconstructs %s retries only while custody and exact successor remain current',
  async (phase) => {
    const f = await setup(300)
    const original = f.prepare()
    if (phase === 'closed') {
      expect(() =>
        original.remove(() => {
          if (f.session.sourceDeliverySnapshotIfKnown(f.actual)?.state === 'closed') {
            throw new Error('interrupted')
          }
        })
      ).toThrow('interrupted')
    } else {
      original.remove(() => {})
    }
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    const retry = f.prepare()
    const revoked = f.revokeSuccessor()
    expect(f.prepare).toThrow('successor_unavailable')
    expect(() => retry.remove(() => {})).toThrow('successor_unavailable')
    revoked.mockRestore()
    f.revokeCustody()
    expect(f.prepare).toThrow('custody lost')
    expect(() => retry.remove(() => {})).toThrow('custody lost')
    f.restoreCustody()
    retry.remove(() => {})
    expect(cancel).toHaveBeenCalledTimes(phase === 'closed' ? 1 : 0)
    expect(f.session.sourceDeliverySnapshotIfKnown(f.actual)).toEqual({
      ...f.actual,
      state: 'closed'
    })
  }
)

it.each(['missing', 'received', 'sent', 'credited', 'token', 'window', 'owner'])(
  'refuses changed closed retry evidence: %s',
  async (change) => {
    const f = await setup(300)
    f.prepare().remove(() => {})
    const closed = f.session.sourceDeliverySnapshotIfKnown(f.actual)!
    const patch = {
      ...(change === 'received' ? { receivedEndSu: 301 } : {}),
      ...(change === 'sent' ? { sentEndSu: 255 } : {}),
      ...(change === 'credited' ? { creditedEndSu: 1 } : {}),
      ...(change === 'token' ? { deliveryToken: 'replacement' } : {}),
      ...(change === 'window' ? { windowSu: 257 } : {}),
      ...(change === 'owner' ? { ownerGeneration: closed.ownerGeneration + 1 } : {})
    }
    vi.spyOn(f.session, 'sourceDeliverySnapshotIfKnown').mockReturnValue(
      change === 'missing' ? null : { ...closed, ...patch }
    )
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    expect(f.prepare).toThrow('closed_ledger_required')
    expect(cancel).not.toHaveBeenCalled()
  }
)

it('does not cancel a replacement publication on an absent retry', async () => {
  const f = await setup()
  f.prepare().remove(() => {})
  const retry = f.prepare()
  const sibling = f.deliveries.get('other')!
  f.deliveries.set('source', { ...sibling })
  const cancel = vi.spyOn(f.session, 'cancelDelivery')
  expect(() => retry.remove(() => {})).toThrow('absence_changed')
  expect(cancel).not.toHaveBeenCalled()
  expect(f.deliveries.has('source')).toBe(true)
})

it.each(['receivedEndSu', 'sentEndSu', 'creditedEndSu'] as const)(
  'refuses an active ledger whose %s changed after preparation',
  async (counter) => {
    const f = await setup(300)
    const cleanup = f.prepare()
    const changed = { ...f.actual, [counter]: f.actual[counter] + 1 }
    vi.spyOn(f.session, 'sourceDeliverySnapshot').mockReturnValue(changed)
    vi.spyOn(f.session, 'sourceDeliverySnapshotIfKnown').mockReturnValue(changed)
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    expect(f.prepare).toThrow('drained_delivery_required')
    expect(() => cleanup.remove(() => {})).toThrow('delivery_changed')
    expect(cancel).not.toHaveBeenCalled()
    expect(f.deliveries.has('source')).toBe(true)
  }
)

it.each(['before', 'after'])('retries a cancellation exception %s ledger closure', async (when) => {
  const f = await setup(300)
  const cleanup = f.prepare()
  const original = f.session.cancelDelivery.bind(f.session)
  const cancel = vi.spyOn(f.session, 'cancelDelivery').mockImplementationOnce((...args) => {
    if (when === 'after') {
      original(...args)
    }
    throw new Error('cancel failed')
  })
  expect(() => cleanup.remove(() => {})).toThrow('cancel failed')
  expect(f.deliveries.has('source')).toBe(true)
  cleanup.remove(() => {})
  expect(cancel).toHaveBeenCalledTimes(2)
  expect(f.session.sourceDeliverySnapshotIfKnown(f.actual)).toEqual({
    ...f.actual,
    state: 'closed'
  })
})
