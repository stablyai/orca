import { afterEach, expect, it, vi } from 'vitest'
import { createSourceRetirementPublicationFixture } from './relay-pty-source-retirement-publication-test-fixture'

const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
})

async function setup(length = 8) {
  const f = await createSourceRetirementPublicationFixture()
  disposals.push(f.dispose)
  const original = f.prepare().delivery
  f.publication.publish('source', { data: 'x'.repeat(length) }, false)
  await new Promise((resolve) => setImmediate(resolve))
  const actual = f.session.sourceDeliverySnapshotIfKnown(original)!
  const { clientId } = await f.resumeOwner()
  return { ...f, actual, clientId }
}

it.each([8, 300])(
  'inspects actual retained counters for %s received units without acknowledging or cancelling',
  async (length) => {
    const f = await setup(length)
    const cancel = vi.spyOn(f.session, 'cancelDelivery')
    expect(f.actual).toMatchObject({
      receivedEndSu: length,
      sentEndSu: Math.min(length, 256),
      creditedEndSu: 0
    })
    expect(
      f.publication.ownershipTransfer.inspectSuccessorRetainedDelivery(
        f.source,
        f.clientId,
        f.actual
      )
    ).toEqual(f.actual)
    expect(
      f.publication.ownershipTransfer.inspectSuccessorDrainedDelivery(
        f.source,
        f.clientId,
        f.actual
      )
    ).toBeNull()
    expect(f.session.sourceDeliverySnapshotIfKnown(f.actual)).toEqual(f.actual)
    expect(cancel).not.toHaveBeenCalled()
  }
)

it.each(['received', 'token', 'window', 'owner', 'client'])(
  'refuses changed expected retained-delivery authority: %s',
  async (change) => {
    const f = await setup()
    const expected = {
      ...f.actual,
      ...(change === 'received' ? { receivedEndSu: 9 } : {}),
      ...(change === 'token' ? { deliveryToken: 'other' } : {}),
      ...(change === 'window' ? { windowSu: 1 } : {}),
      ...(change === 'owner' ? { ownerGeneration: f.actual.ownerGeneration + 1 } : {})
    }
    expect(
      f.publication.ownershipTransfer.inspectSuccessorRetainedDelivery(
        f.source,
        change === 'client' ? 1 : f.clientId,
        expected
      )
    ).toBeNull()
  }
)

it.each([
  { sentEndSu: 9 },
  { sentEndSu: -1 },
  { creditedEndSu: 9 },
  { creditedEndSu: -1 },
  { creditedEndSu: Number.NaN },
  { state: 'closed' as const },
  { exitPublished: true },
  { generationClosed: true }
])('refuses malformed or retired actual ledger state: %j', async (patch) => {
  const f = await setup()
  vi.spyOn(f.session, 'sourceDeliverySnapshot').mockReturnValue({ ...f.actual, ...patch })
  expect(
    f.publication.ownershipTransfer.inspectSuccessorRetainedDelivery(f.source, f.clientId, f.actual)
  ).toBeNull()
})

it('rechecks the exact successor generation after reading unacknowledged delivery', async () => {
  const f = await setup()
  const owner = f.session.activeSessionOwner(f.clientId)!
  vi.spyOn(f.session, 'sourceDeliverySnapshot').mockImplementation(() => {
    vi.spyOn(f.session, 'activeSessionOwner').mockReturnValue({
      ...owner,
      ownerGeneration: owner.ownerGeneration + 1
    })
    return f.actual
  })
  expect(
    f.publication.ownershipTransfer.inspectSuccessorRetainedDelivery(f.source, f.clientId, f.actual)
  ).toBeNull()
})
