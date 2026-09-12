import { afterEach, expect, it, vi } from 'vitest'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'

const disposals: (() => void)[] = []

it('requires fresh delivery evidence when transformed ingress produces no display text', async () => {
  const f = await createSourceRetirementPublicationFixture()
  disposals.push(f.dispose)
  const before = f.prepare().delivery
  f.publication.publish('source', { data: '', rawLength: 7, transformed: true }, false)
  await f.acknowledge('source', 7)
  const actual = f.session.sourceDeliverySnapshotIfKnown(before)!
  expect(actual).toMatchObject({ receivedEndSu: 7, sentEndSu: 7, creditedEndSu: 7 })
  const { clientId } = await f.resumeOwner()
  expect(
    f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, clientId, before)
  ).toBeNull()
  expect(
    f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, clientId, actual)
  ).toEqual(actual)
})

it('does not substitute transformed display length for the retained raw delivery boundary', async () => {
  const f = await createSourceRetirementPublicationFixture()
  disposals.push(f.dispose)
  const original = f.prepare().delivery
  f.publication.publish('source', { data: 'one🙂', rawLength: 12, transformed: true }, false)
  await f.acknowledge('source', 12)
  const actual = f.session.sourceDeliverySnapshotIfKnown(original)!
  expect(actual).toMatchObject({ receivedEndSu: 12, sentEndSu: 12, creditedEndSu: 12 })
  const { clientId } = await f.resumeOwner()
  expect(
    f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, clientId, actual)
  ).toEqual(actual)
  expect(
    f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, clientId, {
      ...actual,
      receivedEndSu: 5,
      sentEndSu: 5,
      creditedEndSu: 5
    })
  ).toBeNull()
})

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
})

it.each([
  { disconnected: false, credited: false },
  { disconnected: false, credited: true },
  { disconnected: true, credited: false },
  { disconnected: true, credited: true }
])(
  'resumed owner fences the incumbent but not its delivery: %j',
  async ({ disconnected, credited }) => {
    const f = await createSourceRetirementPublicationFixture()
    disposals.push(f.dispose)
    const delivery = f.prepare().delivery
    f.publication.publish('source', { data: 'retained' }, false)
    if (credited) {
      await f.acknowledge('source', 8)
    }
    const before = f.session.sourceDeliverySnapshotIfKnown(delivery)!
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    if (disconnected) {
      f.detachOwner()
    }

    const { clientId, response } = await f.resumeOwner()
    expect(response).toMatchObject({
      result: {
        resumed: true,
        ownerLease: f.source.ownerLease,
        ownerGeneration: f.source.sourceOwnerGeneration + 1
      }
    })
    expect(f.session.activeSessionOwner(1)).toBeNull()
    expect(
      f.publication.ownershipTransfer.authorizesResumedTransfer(
        f.source.ownerLease,
        f.source.sourceOwnerGeneration,
        clientId
      )
    ).toBe(true)
    expect(
      f.publication.ownershipTransfer.authorizes(
        'source',
        f.source.ownerLease,
        f.source.sourceOwnerGeneration,
        1
      )
    ).toBe(false)
    expect(f.publication.ownershipTransfer.resolve('source')).toBeNull()
    expect(
      f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, clientId, before)
    ).toEqual(credited ? before : null)
    expect(
      f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, 1, before)
    ).toBeNull()
    expect(f.session.sourceDeliverySnapshotIfKnown(delivery)).toEqual(before)
    expect(before).toMatchObject({
      state: 'active',
      receivedEndSu: 8,
      creditedEndSu: credited ? 8 : 0
    })

    expect(() =>
      f.publication.prepareOwnershipTransferRetirement(f.source, clientId, before)
    ).toThrow('drained_delivery_required')
    expect(cancel).not.toHaveBeenCalled()
  }
)

it.each([
  'token',
  'cursor',
  'window',
  'owner',
  'incarnation',
  'state',
  'exit',
  'generation',
  'missing'
])('successor inspection refuses changed saved delivery evidence: %s', async (change) => {
  const f = await createSourceRetirementPublicationFixture()
  disposals.push(f.dispose)
  const before = f.prepare().delivery
  const { clientId } = await f.resumeOwner()
  const expected = {
    ...before,
    ...(change === 'token' ? { deliveryToken: 'replacement' } : {}),
    ...(change === 'cursor' ? { receivedEndSu: 1, sentEndSu: 1, creditedEndSu: 1 } : {}),
    ...(change === 'window' ? { windowSu: before.windowSu + 1 } : {}),
    ...(change === 'owner' ? { ownerGeneration: before.ownerGeneration + 1 } : {}),
    ...(change === 'incarnation' ? { ptyIncarnation: 'replacement' } : {}),
    ...(change === 'state' ? { state: 'closed' as const } : {}),
    ...(change === 'exit' ? { exitPublished: true } : {}),
    ...(change === 'generation' ? { generationClosed: true } : {})
  }
  if (change === 'missing') {
    vi.spyOn(f.session, 'sourceDeliverySnapshot').mockImplementation(() => {
      throw new Error('unknown delivery')
    })
  }
  expect(
    f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, clientId, expected)
  ).toBeNull()
})

it.each(['lost', 'newer'])('rechecks successor authority after ledger read: %s', async (change) => {
  const f = await createSourceRetirementPublicationFixture()
  disposals.push(f.dispose)
  const before = f.prepare().delivery
  const { clientId } = await f.resumeOwner()
  const owner = f.session.activeSessionOwner(clientId)!
  const read = f.session.sourceDeliverySnapshot.bind(f.session)
  vi.spyOn(f.session, 'sourceDeliverySnapshot').mockImplementation((identity) => {
    const snapshot = read(identity)
    vi.spyOn(f.session, 'activeSessionOwner').mockReturnValue(
      change === 'lost' ? null : { ...owner, ownerGeneration: owner.ownerGeneration + 1 }
    )
    return snapshot
  })
  expect(
    f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(f.source, clientId, before)
  ).toBeNull()
})
