import { expect, it, vi } from 'vitest'
import { OrcadDelegatedProviderControls } from './orcad-delegated-provider-controls'
import { OrcadDelegatedProviderInput } from './orcad-delegated-provider-input'
import { setupDelegatedPtyOperations } from './orcad-delegated-pty-operations-fixture'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

function setup() {
  const fixture = setupDelegatedPtyOperations()
  const onError = vi.fn()
  const input = new OrcadDelegatedProviderInput({
    ptyId: identity.terminalId,
    operations: fixture.operations,
    readInputs: fixture.readInputs,
    isActive: fixture.isActive,
    onError
  })
  const controls = new OrcadDelegatedProviderControls({
    incarnationId: identity.incarnationId,
    input,
    operations: fixture.operations,
    onError
  })
  return { ...fixture, input, controls, onError }
}

it('orders resize and shutdown behind already-admitted input', async () => {
  const fixture = setup()
  let finish!: () => void
  const dispatch = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementationOnce(async (method, params) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return dispatch(method, params)
  })
  const write = fixture.input.writeWithSettlement(identity.terminalId, 'data', {
    operationId: 'write'
  })
  fixture.controls.resize(identity.terminalId, 90, 30, { operationId: 'resize' })
  const stop = fixture.controls.shutdown(identity.terminalId, {
    operationId: 'stop',
    expectedIncarnationId: identity.incarnationId
  })
  await vi.waitFor(() => expect(fixture.transport).toHaveBeenCalledOnce())
  finish()
  await Promise.all([write, stop])
  expect(
    fixture.transport.mock.calls.map(([, params]) => params.controlId ?? params.inputId)
  ).toEqual(['write', 'resize', 'stop'])
})

it.each([
  { expectedIncarnationId: 'wrong' },
  { expectedOwnerClientInstanceId: 'client' },
  { keepHistory: true }
])('refuses unproven shutdown constraints without dispatch %#', async (options) => {
  const fixture = setup()
  await expect(fixture.controls.shutdown(identity.terminalId, options)).rejects.toThrow(
    'unsupported'
  )
  expect(fixture.transport).not.toHaveBeenCalled()
})

it('rejects expired shutdown before touching the host', async () => {
  const fixture = setup()
  await expect(
    fixture.controls.shutdown(identity.terminalId, { deadlineMs: Date.now() - 1 })
  ).rejects.toThrow('deadline_expired')
  expect(fixture.transport).not.toHaveBeenCalled()
})

it('does not turn an unverifiable control into success', async () => {
  const fixture = setup()
  fixture.transport.mockResolvedValueOnce({
    ...identity,
    version: 1,
    outcome: 'unverifiable',
    duplicate: false,
    controlId: 'signal',
    inputId: undefined,
    inputEpoch: undefined
  })
  await expect(
    fixture.controls.sendSignal(identity.terminalId, 'SIGINT', { operationId: 'signal' })
  ).rejects.toThrow('unverifiable')
})

it('contains asynchronous resize errors and refuses cached controls after disconnect', async () => {
  const fixture = setup()
  fixture.isActive.mockReturnValue(false)
  fixture.controls.resize(identity.terminalId, 80, 24)
  await vi.waitFor(() => expect(fixture.onError).toHaveBeenCalledOnce())
  await expect(fixture.controls.clearBuffer(identity.terminalId)).rejects.toThrow('unverifiable')
  expect(fixture.transport).not.toHaveBeenCalled()
})
