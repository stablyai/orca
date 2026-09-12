import { expect, it, vi } from 'vitest'
import { catalogActivationFixture } from '../ssh/orcad-catalog-activation-test-fixture'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import { inspectOrcadPublishedDestinationOutputCoverage } from './orcad-delegated-output-coverage'

function fixture() {
  const f = catalogActivationFixture()
  const { identity, destinationClaim } = f.activation
  const status = {
    ...identity,
    version: 1,
    phase: 'committed',
    boundToConnection: true,
    destinationClaim,
    receipt: f.activation.publicationReceipt.commitReceipt
  }
  const transport = vi.fn(async () => status)
  const connection = {
    client: new OrcadDelegatedTransferClient(transport),
    proof: { ...identity, version: 1, credential: 'b'.repeat(64), destinationClaim },
    isActive: vi.fn(() => true),
    isCommitReconciled: vi.fn(() => true)
  }
  const current = vi.fn(() => connection)
  const coverage = {
    throughSeq: 2,
    acknowledgedEndSeq: 3,
    modelThroughSeq: 3,
    modelSequenceEnd: 120
  }
  const outbox = { inspectAppliedCoverage: vi.fn(() => coverage) }
  const destination = {
    outbox,
    adapter: { snapshot: () => ({ publicationReceipt: f.activation.publicationReceipt }) },
    store: { surface: { loadCatalogAdmission: () => f.activation.catalogAdmission } }
  }
  const run = (throughSeq = 2) =>
    inspectOrcadPublishedDestinationOutputCoverage({
      identity,
      throughSeq,
      signal: new AbortController().signal,
      registry: { getPublishedDelegatedDestination: () => destination } as never,
      supervisor: { getConnection: current } as never,
      connection: connection as never
    })
  return { ...f, run, connection, current, outbox, coverage, transport }
}

it('joins fresh activation and durable applied coverage without leaking credentials or model text', async () => {
  const f = fixture()
  expect(await f.run()).toEqual({ ...f.activation, coverage: f.coverage })
  expect(f.outbox.inspectAppliedCoverage).toHaveBeenCalledWith(f.request.identity, 2)
  expect(f.transport).toHaveBeenCalledOnce()
})

it('propagates unconfirmed model coverage instead of returning activation alone', async () => {
  const f = fixture()
  f.outbox.inspectAppliedCoverage.mockImplementation(() => {
    throw new Error('model not applied')
  })
  await expect(f.run()).rejects.toThrow('model not applied')
})

it.each(['connection', 'inactive', 'commit', 'publication'])(
  'refuses %s authority changes during the coverage read',
  async (kind) => {
    const f = fixture()
    f.outbox.inspectAppliedCoverage.mockImplementation(() => {
      if (kind === 'connection') {
        f.current.mockReturnValue({ ...f.connection })
      }
      if (kind === 'inactive') {
        f.connection.isActive.mockReturnValue(false)
      }
      if (kind === 'commit') {
        f.connection.isCommitReconciled.mockReturnValue(false)
      }
      if (kind === 'publication') {
        f.activation.publicationReceipt.publicationReceiptId = 'changed'
      }
      return f.coverage
    })
    await expect(f.run()).rejects.toThrow('authority_changed')
  }
)

it.each([-1, Number.NaN, 0.5])(
  'refuses invalid sequence %s before contacting source',
  async (seq) => {
    const f = fixture()
    await expect(f.run(seq)).rejects.toThrow('sequence_invalid')
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.outbox.inspectAppliedCoverage).not.toHaveBeenCalled()
  }
)
