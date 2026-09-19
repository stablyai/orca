import { expect, it, vi } from 'vitest'
import { catalogActivationFixture } from '../ssh/orcad-catalog-activation-test-fixture'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import { retireOrcadPublishedSourceDelivery } from './orcad-delegated-source-retirement'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD as STATUS } from '../../shared/pty-ownership-transfer-destination-claim'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD as RETIRE } from '../../shared/pty-ownership-transfer-source-retirement'

function fixture() {
  const f = catalogActivationFixture()
  const { identity, destinationClaim } = f.activation
  const delivery = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 2,
    clientGeneration: 3,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'delivery',
    state: 'active',
    windowSu: 100,
    receivedEndSu: 10,
    sentEndSu: 10,
    creditedEndSu: 10,
    generationClosed: false,
    exitPublished: false
  }
  const retirementRecordSha256 = 'a'.repeat(64)
  const result = {
    ...identity,
    version: 1,
    sourceDeliveryRetirement: { phase: 'retired', retirementRecordSha256, delivery }
  }
  const status = {
    ...identity,
    version: 1,
    phase: 'committed',
    boundToConnection: true,
    destinationClaim,
    sourceRetirementVersion: 1,
    sourceRetirementBoundaryVersion: 1,
    receipt: f.activation.publicationReceipt.commitReceipt
  }
  const transport = vi.fn(async (method: string) => (method === STATUS ? status : result))
  const connection = {
    client: new OrcadDelegatedTransferClient(transport),
    proof: { ...identity, version: 1, credential: 'b'.repeat(64), destinationClaim },
    isActive: vi.fn(() => true),
    isCommitReconciled: vi.fn(() => true)
  }
  const current = vi.fn(() => connection)
  const catalog = vi.fn(() => f.activation.catalogAdmission)
  const registry = {
    getPublishedDelegatedDestination: () => ({
      adapter: { snapshot: () => ({ publicationReceipt: f.activation.publicationReceipt }) },
      store: { surface: { loadCatalogAdmission: catalog } }
    })
  }
  const run = (recoveryOnly?: boolean) =>
    retireOrcadPublishedSourceDelivery({
      identity,
      signal: new AbortController().signal,
      retirementRecordSha256,
      expectedDelivery: delivery,
      ...(recoveryOnly === undefined ? {} : { recoveryOnly }),
      connection: connection as never,
      supervisor: { getConnection: current } as never,
      registry: registry as never
    })
  return { run, transport, connection, current, catalog, result, status }
}

it('retires through the activated destination claim without exposing credentials', async () => {
  const f = fixture()
  expect(await f.run()).toEqual(f.result)
  expect(f.transport.mock.calls.map(([method]) => method)).toEqual([STATUS, STATUS, RETIRE])
})

it('forwards recovery through the fresh supervised claim and preserves cancellation', async () => {
  const f = fixture()
  Object.assign(f.status, { sourceRetirementRecoveryVersion: 1 })
  Object.assign(f.result, {
    sourceCancellation: { canceled: true, sentEndSu: 10, creditedEndSu: 10 }
  })
  await expect(f.run(true)).resolves.toHaveProperty('sourceCancellation.canceled', true)
  expect(f.transport).toHaveBeenCalledWith(
    RETIRE,
    expect.objectContaining({ recoveryOnly: true }),
    expect.anything()
  )
})

it.each(['connection', 'catalog', 'inactive', 'commit'] as const)(
  'refuses %s changes during the retirement capability probe',
  async (change) => {
    const f = fixture()
    let calls = 0
    f.transport.mockImplementation(async () => {
      if (++calls === 2) {
        if (change === 'connection') {
          f.current.mockReturnValue({ ...f.connection })
        }
        if (change === 'catalog') {
          f.catalog.mockReturnValue(null as never)
        }
        if (change === 'inactive') {
          f.connection.isActive.mockReturnValue(false)
        }
        if (change === 'commit') {
          f.connection.isCommitReconciled.mockReturnValue(false)
        }
      }
      return f.status
    })
    await expect(f.run()).rejects.toThrow('authority_changed')
    expect(f.transport.mock.calls.map(([method]) => method)).toEqual([STATUS, STATUS])
  }
)

it('does not acknowledge completion after connection replacement during retirement', async () => {
  const f = fixture()
  f.transport.mockImplementation(async (method) => {
    if (method === RETIRE) {
      f.current.mockReturnValue({ ...f.connection })
      return f.result
    }
    return f.status
  })
  await expect(f.run()).rejects.toThrow('authority_changed')
  expect(f.transport).toHaveBeenCalledTimes(3)
})
