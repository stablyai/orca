import { expect, it, vi } from 'vitest'
import {
  createOrcadDelegatedPtyProvider,
  createOrcadDelegatedProviderBinding,
  bindOrcadDelegatedPtyProvider
} from './orcad-delegated-pty-provider'
import { getDelegatedPtyProvider } from '../ipc/pty/provider/delegated-provider-routes'
import { identity as base } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

function setup(terminalId = 'facade-pty') {
  const identity = { ...base, terminalId }
  const isActive = vi.fn(() => true)
  const providerInput = {
    write: vi.fn(() => true),
    writeWithSettlement: vi.fn(async () => true),
    retireWriteOperation: vi.fn(async () => true)
  }
  const providerControls = {
    resize: vi.fn(),
    shutdown: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    clearBuffer: vi.fn(async () => {})
  }
  const providerInspection = {
    getCwd: vi.fn(async () => '/host'),
    getInitialCwd: vi.fn(async () => '/initial'),
    getAppliedSize: vi.fn(async () => ({ cols: 80, rows: 24 })),
    hasChildProcesses: vi.fn(async () => true),
    getForegroundProcess: vi.fn(async () => 'agent'),
    listProcesses: vi.fn(async () => [])
  }
  const providerAttachment = {
    attach: vi.fn(async () => ({ providerSequence: { value: 105, generation: 'continued' } })),
    getBufferSnapshot: vi.fn(async () => null)
  }
  const onExit = vi.fn(() => () => {})
  const refreshExecution = vi.fn(async () => ({ executionVerdict: 'live' }))
  const connection = {
    receiver: { retryOutput: vi.fn() },
    proof: { ...identity, destinationClaim: { generation: 1, claimId: 'first' } },
    isActive,
    providerInput,
    providerControls,
    providerInspection,
    providerAttachment,
    onExit,
    refreshExecution
  }
  const hostProfiles = {
    getDefaultShell: vi.fn(async () => '/host/shell'),
    getProfiles: vi.fn(async () => [])
  }
  const clearBuffer = vi.fn(async () => {})
  const options = {
    connection: connection as never,
    getHostProfiles: () => hostProfiles,
    clearBuffer
  }
  const provider = createOrcadDelegatedPtyProvider(options)
  return { identity, connection, options, provider, hostProfiles, clearBuffer }
}

it('composes existing adapters without dropping operation retry identities', async () => {
  const f = setup()
  const id = f.identity.terminalId
  const retry = { operationId: 'retry' }
  expect(f.provider.write(id, 'input', retry)).toBe(true)
  expect(f.connection.providerInput.write).toHaveBeenCalledWith(id, 'input', retry)
  await f.provider.writeWithSettlement!(id, 'input', retry)
  expect(f.connection.providerInput.writeWithSettlement).toHaveBeenCalledWith(id, 'input', retry)
  await f.provider.retireWriteOperation!(id, retry.operationId)
  expect(f.connection.providerInput.retireWriteOperation).toHaveBeenCalledWith(id, 'retry')
  f.provider.resize(id, 120, 30, retry)
  expect(f.connection.providerControls.resize).toHaveBeenCalledWith(id, 120, 30, retry)
  await f.provider.sendSignal(id, 'SIGINT', retry)
  expect(f.connection.providerControls.sendSignal).toHaveBeenCalledWith(id, 'SIGINT', retry)
  const shutdown = { immediate: true, deadlineMs: 123, operationId: 'stop' }
  await f.provider.shutdown(id, shutdown)
  expect(f.connection.providerControls.shutdown).toHaveBeenCalledWith(id, shutdown)
})

it('uses destination model attachment and keeps renderer credits off the source ACK lane', async () => {
  const f = setup()
  await expect(f.provider.attach(f.identity.terminalId)).resolves.toEqual({
    providerSequence: { value: 105, generation: 'continued' }
  })
  const data = vi.fn()
  const replay = vi.fn()
  f.provider.onData(data)()
  f.provider.onReplay(replay)()
  f.provider.acknowledgeDataEvent(f.identity.terminalId, 100)
  expect(data).not.toHaveBeenCalled()
  expect(replay).not.toHaveBeenCalled()
  expect(f.connection.providerInput.write).not.toHaveBeenCalled()
  const exit = vi.fn()
  f.provider.onExit(exit)
  expect(f.connection.onExit).toHaveBeenCalledWith(exit)
})

it('requires destination clear semantics instead of silently clearing only the source', async () => {
  const f = setup()
  const retry = { operationId: 'clear' }
  await f.provider.clearBuffer(f.identity.terminalId, retry)
  expect(f.clearBuffer).toHaveBeenCalledWith(f.identity.terminalId, retry)
  expect(f.connection.providerControls.clearBuffer).not.toHaveBeenCalled()
  f.clearBuffer.mockRejectedValueOnce(new Error('durable clear unavailable'))
  await expect(f.provider.clearBuffer(f.identity.terminalId)).rejects.toThrow(
    'durable clear unavailable'
  )
  await expect(f.provider.clearBuffer('other')).rejects.toThrow('unverifiable')
  expect(f.clearBuffer).toHaveBeenCalledTimes(2)
})

it('never cold-spawns or substitutes generic JSON revival for durable transfer recovery', async () => {
  const f = setup()
  await expect(f.provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
    'durable_transfer_recovery'
  )
  await expect(f.provider.serialize([f.identity.terminalId])).rejects.toThrow(
    'durable_transfer_recovery'
  )
  await expect(f.provider.revive('{}')).rejects.toThrow('durable_transfer_recovery')
})

it('maps authenticated execution evidence without treating a failed probe as absence', async () => {
  const f = setup()
  await expect(f.provider.probePtyLiveness!(f.identity.terminalId)).resolves.toBe(true)
  f.connection.refreshExecution.mockResolvedValueOnce({ executionVerdict: 'exited' })
  await expect(f.provider.probePtyLiveness!(f.identity.terminalId)).resolves.toBe(false)
  f.connection.refreshExecution.mockResolvedValueOnce({ executionVerdict: 'unverifiable' })
  await expect(f.provider.probePtyLiveness!(f.identity.terminalId)).resolves.toBeNull()
  f.connection.refreshExecution.mockRejectedValueOnce(new Error('offline'))
  await expect(f.provider.probePtyLiveness!(f.identity.terminalId)).resolves.toBeNull()
})

it('queries only supplied host profiles and fences late responses after disconnect', async () => {
  const f = setup()
  await expect(f.provider.getDefaultShell()).resolves.toBe('/host/shell')
  f.hostProfiles.getProfiles.mockImplementationOnce(async () => {
    f.connection.isActive.mockReturnValue(false)
    return []
  })
  await expect(f.provider.getProfiles()).rejects.toThrow('unverifiable')
  expect(f.provider.canProvideAuthoritativeBufferSnapshot!(f.identity.terminalId)).toBe(false)
})

it('binds the concrete provider and preserves an unavailable reservation after cleanup', () => {
  const f = setup('facade-bound')
  const release = bindOrcadDelegatedPtyProvider(f.identity, f.options)
  const bound = getDelegatedPtyProvider(f.identity.terminalId)!
  expect(bound.write).toBe(f.connection.providerInput.write)
  release()
  release()
  expect(() => getDelegatedPtyProvider(f.identity.terminalId)).toThrow('unverifiable')
})

it('refuses changed identities and incomplete connections before reserving any route', () => {
  const f = setup('facade-rejected')
  expect(() =>
    bindOrcadDelegatedPtyProvider({ ...f.identity, incarnationId: 'other' }, f.options)
  ).toThrow('identity_mismatch')
  f.connection.isActive.mockReturnValue(false)
  expect(() => bindOrcadDelegatedPtyProvider(f.identity, f.options)).toThrow('provider_unavailable')
  expect(getDelegatedPtyProvider(f.identity.terminalId)).toBeUndefined()
})

it('wires runtime clear to the connection claim and preserves caller retry IDs', async () => {
  const f = setup('facade-runtime-bound')
  const runtime = { clearPublishedDelegatedPtyModel: vi.fn(async () => {}) }
  const bind = createOrcadDelegatedProviderBinding(runtime, () => f.hostProfiles)
  const unbind = bind(f.identity, f.options.connection)
  const provider = getDelegatedPtyProvider(f.identity.terminalId)!
  await provider.clearBuffer(f.identity.terminalId, { operationId: 'caller-clear' })
  expect(runtime.clearPublishedDelegatedPtyModel).toHaveBeenCalledWith(
    f.identity,
    'caller-clear',
    f.connection.proof.destinationClaim
  )
  await provider.clearBuffer(f.identity.terminalId)
  expect(runtime.clearPublishedDelegatedPtyModel).toHaveBeenLastCalledWith(
    f.identity,
    expect.any(String),
    f.connection.proof.destinationClaim
  )
  expect(f.connection.receiver.retryOutput).toHaveBeenCalledTimes(2)
  unbind()
})
