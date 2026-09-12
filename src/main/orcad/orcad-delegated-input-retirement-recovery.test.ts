import { expect, it } from 'vitest'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { setupDelegatedPtyOperations } from './orcad-delegated-pty-operations-fixture'

async function setup() {
  const fixture = setupDelegatedPtyOperations()
  await fixture.operations.input(identity.terminalId, 'input', 'data', 0)
  await fixture.operations.settleInput(identity.terminalId, 'input', 0)
  fixture.transport.mockRejectedValueOnce(new Error('reply lost'))
  await expect(fixture.operations.retireInput(identity.terminalId, ['input'], 0)).rejects.toThrow(
    'reply lost'
  )
  fixture.transport.mockClear()
  return fixture
}
function status(fixture: Awaited<ReturnType<typeof setup>>, inputEpoch: number | undefined) {
  return {
    ...identity,
    version: 1,
    phase: 'committed',
    boundToConnection: true,
    destinationClaim: fixture.snapshot.delegatedClaim,
    receipt: fixture.snapshot.publicationReceipt!.commitReceipt,
    inputEpoch
  }
}

it('finishes a host-completed retirement without resending it', async () => {
  const fixture = await setup()
  fixture.transport.mockResolvedValueOnce(status(fixture, 1) as never)
  await expect(fixture.operations.recoverInputRetirement(identity.terminalId)).resolves.toEqual({
    epoch: 1,
    retiring: false,
    entries: []
  })
  expect(fixture.transport).toHaveBeenCalledOnce()
  await expect(fixture.operations.recoverInputRetirement(identity.terminalId)).resolves.toBeNull()
  expect(fixture.transport).toHaveBeenCalledOnce()
  await fixture.operations.input(identity.terminalId, 'new', 'new-data', 1)
})

it('retries exactly the persisted retirement when the host has not advanced', async () => {
  const fixture = await setup()
  fixture.transport.mockResolvedValueOnce(status(fixture, 0) as never)
  fixture.transport.mockResolvedValueOnce({
    ...identity,
    version: 1,
    retired: 1,
    inputEpoch: 1
  } as never)
  await fixture.operations.recoverInputRetirement(identity.terminalId)
  expect(fixture.transport.mock.calls[1][1]).toMatchObject({ inputIds: ['input'], inputEpoch: 0 })
  expect(fixture.readInputs()).toEqual({ epoch: 1, retiring: false, entries: [] })
})

it.each([
  { inputEpoch: undefined },
  { inputEpoch: 2 },
  { boundToConnection: false },
  { destinationClaim: { generation: 2, claimId: 'other' } }
])('preserves the intent when source evidence cannot prove retirement %#', async (patch) => {
  const fixture = await setup()
  fixture.transport.mockResolvedValueOnce({ ...status(fixture, 1), ...patch } as never)
  await expect(fixture.operations.recoverInputRetirement(identity.terminalId)).rejects.toThrow()
  expect(fixture.readInputs()).toMatchObject({ epoch: 0, retiring: true })
  expect(fixture.transport).toHaveBeenCalledOnce()
})

it('does not advance the journal when authority is lost during the source probe', async () => {
  const fixture = await setup()
  fixture.transport.mockImplementationOnce(async () => {
    fixture.isActive.mockReturnValue(false)
    return status(fixture, 1) as never
  })
  await expect(fixture.operations.recoverInputRetirement(identity.terminalId)).rejects.toThrow()
  expect(fixture.readInputs()).toMatchObject({ epoch: 0, retiring: true })
})

it('does not persist applied input if publication changes during its reply', async () => {
  const fixture = setupDelegatedPtyOperations()
  const dispatch = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementationOnce(async (method, params) => {
    const result = await dispatch(method, params)
    fixture.snapshot.publicationReceipt!.publicationReceiptId = 'changed'
    return result
  })
  await expect(fixture.operations.input(identity.terminalId, 'input', 'data', 0)).rejects.toThrow(
    'superseded'
  )
  expect(fixture.readInputs().entries[0].phase).toBe('attempted')
})
