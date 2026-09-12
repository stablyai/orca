import { expect, it, vi } from 'vitest'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import { identity, request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD as STATUS } from '../../shared/pty-ownership-transfer-destination-claim'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD as RETIRE } from '../../shared/pty-ownership-transfer-source-retirement'

const value = {
  ...request(),
  destinationClaim: { generation: 1, claimId: 'claim-1' },
  retirementRecordSha256: 'a'.repeat(64)
}
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
const status = {
  ...identity,
  version: 1,
  phase: 'committed',
  boundToConnection: true,
  destinationClaim: value.destinationClaim,
  sourceRetirementVersion: 1,
  sourceRetirementBoundaryVersion: 1,
  receipt: {
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-07T00:00:00.000Z'
  }
}
const response = {
  ...identity,
  version: 1,
  sourceDeliveryRetirement: {
    phase: 'retired',
    retirementRecordSha256: value.retirementRecordSha256,
    delivery
  }
}

it('negotiates before retirement, forwards options and sanitizes acknowledgment', async () => {
  const transport = vi.fn(async (method: string) =>
    method === STATUS
      ? status
      : {
          ...response,
          credential: value.credential
        }
  )
  const options = { timeoutMs: 100, signal: new AbortController().signal }
  const result = await new OrcadDelegatedTransferClient(transport).retireSourceDelivery(
    value,
    delivery,
    options
  )
  expect(transport.mock.calls.map(([method]) => method)).toEqual([STATUS, RETIRE])
  expect(transport).toHaveBeenNthCalledWith(
    2,
    RETIRE,
    expect.objectContaining({
      retirementRecordSha256: value.retirementRecordSha256,
      expectedDelivery: delivery
    }),
    options
  )
  expect(result).toEqual(response)
  expect(result).not.toHaveProperty('credential')
  expect(Object.isFrozen(result.sourceDeliveryRetirement.delivery)).toBe(true)
})

it.each([undefined, 2])(
  'refuses recovery without negotiated support %s before mutation',
  async (version) => {
    const transport = vi.fn(async () => ({ ...status, sourceRetirementRecoveryVersion: version }))
    await expect(
      new OrcadDelegatedTransferClient(transport).retireSourceDelivery(
        { ...value, recoveryOnly: true },
        delivery
      )
    ).rejects.toThrow('recovery_unsupported')
    expect(transport).toHaveBeenCalledOnce()
  }
)

it.each([false, true])(
  'requires explicit cancellation confirmation for recovery: %s',
  async (confirmed) => {
    const cancellation = { canceled: true, sentEndSu: 10, creditedEndSu: 10 }
    const transport = vi.fn(async (method: string) =>
      method === STATUS
        ? { ...status, sourceRetirementRecoveryVersion: 1 }
        : { ...response, ...(confirmed ? { sourceCancellation: cancellation } : {}) }
    )
    const result = new OrcadDelegatedTransferClient(transport).retireSourceDelivery(
      { ...value, recoveryOnly: true },
      delivery
    )
    await (confirmed
      ? expect(result).resolves.toMatchObject({ sourceCancellation: cancellation })
      : expect(result).rejects.toThrow('cancellation_required'))
    expect(transport).toHaveBeenLastCalledWith(
      RETIRE,
      expect.objectContaining({ recoveryOnly: true, expectedDelivery: delivery }),
      undefined
    )
  }
)

it.each([
  { sourceRetirementVersion: undefined },
  { sourceRetirementVersion: 2 },
  { sourceRetirementBoundaryVersion: undefined },
  { sourceRetirementBoundaryVersion: 2 },
  { terminalId: 'other' },
  { boundToConnection: false },
  { phase: 'prepared', receipt: undefined },
  { destinationClaim: { generation: 2, claimId: 'claim-1' } },
  { destinationClaim: { generation: 1, claimId: 'other' } }
])('refuses unsupported or mismatched authority before mutation %#', async (patch) => {
  const transport = vi.fn(async () => ({ ...status, ...patch }))
  await expect(
    new OrcadDelegatedTransferClient(transport).retireSourceDelivery(value, delivery)
  ).rejects.toThrow()
  expect(transport).toHaveBeenCalledOnce()
  expect(transport).toHaveBeenCalledWith(STATUS, expect.any(Object), undefined)
})

it.each([
  { creditedEndSu: 9 },
  { generationClosed: true },
  { providerGeneration: 0 },
  { id: 'other' },
  { deliveryToken: '' }
])('rejects malformed expected host delivery before transport %#', async (patch) => {
  const transport = vi.fn()
  await expect(
    new OrcadDelegatedTransferClient(transport).retireSourceDelivery(value, {
      ...delivery,
      ...patch
    })
  ).rejects.toThrow()
  expect(transport).not.toHaveBeenCalled()
})

it.each([
  { version: 2 },
  { ownerLease: 'other' },
  { sourceDeliveryRetirement: { ...response.sourceDeliveryRetirement, phase: 'prepared' } },
  {
    sourceDeliveryRetirement: {
      ...response.sourceDeliveryRetirement,
      retirementRecordSha256: 'b'.repeat(64)
    }
  },
  ...[
    { deliveryToken: 'other' },
    { providerGeneration: 4 },
    { clientGeneration: 4 },
    { receivedEndSu: 11, sentEndSu: 11, creditedEndSu: 11 },
    { creditedEndSu: 9 }
  ].map((patch) => ({
    sourceDeliveryRetirement: {
      ...response.sourceDeliveryRetirement,
      delivery: { ...delivery, ...patch }
    }
  }))
])('rejects mismatched acknowledgment without retrying %#', async (patch) => {
  const transport = vi.fn(async (method: string) =>
    method === STATUS ? status : { ...response, ...patch }
  )
  await expect(
    new OrcadDelegatedTransferClient(transport).retireSourceDelivery(value, delivery)
  ).rejects.toThrow()
  expect(transport).toHaveBeenCalledTimes(2)
})

it.each(['before', STATUS, RETIRE])(
  'honors abort at %s without accepting completion',
  async (stage) => {
    const controller = new AbortController()
    if (stage === 'before') {
      controller.abort(new Error('cancelled'))
    }
    const transport = vi.fn(async (method: string) => {
      if (stage === method) {
        controller.abort(new Error('cancelled'))
      }
      return method === STATUS ? status : response
    })
    await expect(
      new OrcadDelegatedTransferClient(transport).retireSourceDelivery(value, delivery, {
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled')
    expect(transport).toHaveBeenCalledTimes(stage === 'before' ? 0 : stage === STATUS ? 1 : 2)
  }
)

it.each(['before', STATUS, RETIRE])('rechecks caller authority at %s', async (stage) => {
  let valid = stage !== 'before'
  const transport = vi.fn(async (method: string) => {
    if (stage === method) {
      valid = false
    }
    return method === STATUS ? status : response
  })
  await expect(
    new OrcadDelegatedTransferClient(transport).retireSourceDelivery(
      value,
      delivery,
      undefined,
      () => {
        if (!valid) {
          throw new Error('authority changed')
        }
      }
    )
  ).rejects.toThrow('authority changed')
  expect(transport).toHaveBeenCalledTimes(stage === 'before' ? 0 : stage === STATUS ? 1 : 2)
})
