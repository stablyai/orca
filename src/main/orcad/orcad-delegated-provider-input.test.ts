import { expect, it, vi } from 'vitest'
import { OrcadDelegatedProviderInput } from './orcad-delegated-provider-input'
import { setupDelegatedPtyOperations } from './orcad-delegated-pty-operations-fixture'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

function setup() {
  const fixture = setupDelegatedPtyOperations()
  const dispatch = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementation(async (method, params) => {
    if (Array.isArray(params.inputIds)) {
      return {
        ...identity,
        version: 1,
        inputEpoch: Number(params.inputEpoch) + 1,
        retired: params.inputIds.length
      } as never
    }
    return dispatch(method, params)
  })
  const onError = vi.fn()
  let nextId = 0
  const input = new OrcadDelegatedProviderInput({
    ptyId: identity.terminalId,
    operations: fixture.operations,
    readInputs: fixture.readInputs,
    isActive: fixture.isActive,
    onError,
    createInputId: () => `generated-${++nextId}`
  })
  return { ...fixture, input, onError }
}

it('settles generated writes and advances epochs in order without retaining every keystroke', async () => {
  const fixture = setup()
  await Promise.all([
    fixture.input.writeWithSettlement(identity.terminalId, 'a'),
    fixture.input.writeWithSettlement(identity.terminalId, 'b')
  ])
  await fixture.input.whenIdle()
  expect(fixture.readInputs()).toEqual({ epoch: 2, retiring: false, entries: [] })
  expect(
    fixture.transport.mock.calls
      .filter(([, params]) => params.data)
      .map(([, params]) => params.inputEpoch)
  ).toEqual([0, 1])
})

it('retains caller retry IDs until explicitly settled and retires only a fully settled epoch', async () => {
  const fixture = setup()
  await fixture.input.writeWithSettlement(identity.terminalId, 'a', { operationId: 'first' })
  await fixture.input.writeWithSettlement(identity.terminalId, 'b', { operationId: 'second' })
  await expect(fixture.input.retireWriteOperation(identity.terminalId, 'first')).resolves.toBe(true)
  expect(fixture.readInputs()).toMatchObject({ epoch: 0, retiring: false })
  expect(fixture.readInputs().entries.map((entry) => entry.phase)).toEqual(['settled', 'applied'])
  await fixture.input.retireWriteOperation(identity.terminalId, 'second')
  expect(fixture.readInputs()).toEqual({ epoch: 1, retiring: false, entries: [] })
})

it('preserves the caller ID and payload across uncertain replies', async () => {
  const fixture = setup()
  fixture.transport.mockRejectedValueOnce(new Error('reply lost'))
  await expect(
    fixture.input.writeWithSettlement(identity.terminalId, 'data', { operationId: 'retry' })
  ).rejects.toThrow('reply lost')
  await expect(fixture.input.retireWriteOperation(identity.terminalId, 'retry')).resolves.toBe(
    false
  )
  await fixture.input.writeWithSettlement(identity.terminalId, 'data', { operationId: 'retry' })
  expect(fixture.readInputs().entries).toEqual([
    { inputId: 'retry', data: 'data', phase: 'applied' }
  ])
  await expect(
    fixture.input.writeWithSettlement(identity.terminalId, 'changed', { operationId: 'retry' })
  ).rejects.toThrow('payload_conflict')
})

it('fences disconnected and wrong-terminal writes without local fallback', async () => {
  const fixture = setup()
  expect(fixture.input.write('other', 'data')).toBe(false)
  fixture.isActive.mockReturnValue(false)
  expect(fixture.input.write(identity.terminalId, 'data')).toBe(false)
  await expect(fixture.input.writeWithSettlement(identity.terminalId, 'data')).rejects.toThrow(
    'unverifiable'
  )
  expect(fixture.transport).not.toHaveBeenCalled()
})

it('reports cleanup failure without rejecting an applied generated write', async () => {
  const fixture = setup()
  vi.spyOn(fixture.operations, 'retireInput').mockRejectedValueOnce(new Error('cleanup lost'))
  await expect(fixture.input.writeWithSettlement(identity.terminalId, 'data')).resolves.toBe(true)
  await fixture.input.whenIdle()
  expect(fixture.readInputs().entries[0].phase).toBe('settled')
  expect(fixture.onError).toHaveBeenCalledOnce()
})

it('acknowledges an applied write while keeping later writes behind pending cleanup', async () => {
  const fixture = setup()
  let finish!: () => void
  const retire = fixture.operations.retireInput
  vi.spyOn(fixture.operations, 'retireInput').mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return retire(...args)
  })
  await expect(fixture.input.writeWithSettlement(identity.terminalId, 'first')).resolves.toBe(true)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const later = fixture.input.writeWithSettlement(identity.terminalId, 'second')
  expect(fixture.transport).toHaveBeenCalledOnce()
  finish()
  await expect(later).resolves.toBe(true)
  await fixture.input.whenIdle()
  expect(fixture.readInputs().epoch).toBe(2)
})

it('rejects oversized queued input before dispatch', async () => {
  const fixture = setup()
  expect(fixture.input.write(identity.terminalId, 'x'.repeat(4 * 1024 * 1024 + 1))).toBe(false)
  expect(fixture.transport).not.toHaveBeenCalled()
})
