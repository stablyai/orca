import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { registerRuntimeEnvironmentReconciliationHandlers } from './runtime-environment-reconciliation-handlers'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  enabled: vi.fn(),
  prepare: vi.fn(),
  transition: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../shared/pty-ownership-transfer-release-gate', () => ({
  isPtyOwnershipTransferMutationEnabled: mocks.enabled
}))
vi.mock('../runtime/runtime-environment-reconciliation-verification', () => ({
  prepareVerifiedRuntimeEnvironmentReconciliation: mocks.prepare
}))
vi.mock('../runtime/runtime-environment-reconciliation-coordinator', () => ({
  transitionRuntimeEnvironmentReconciliationCatalog: mocks.transition,
  cancelRuntimeEnvironmentReconciliation: mocks.cancel
}))

const retire = vi.fn()
const prepare = {
  action: 'prepare',
  requestId: 'request',
  environmentIds: ['left', 'right'],
  canonicalEnvironmentId: 'left'
}
const selection = { environmentId: 'left', requestId: 'request' }
function record(stage = 'prepared') {
  return {
    version: 1,
    stage,
    requestId: 'request',
    canonicalEnvironmentId: 'left',
    runtimeId: 'host',
    preparedAt: 1,
    registrations: ['left', 'right'].map((environmentId) => ({
      environmentId,
      authorityDigest: 'a'.repeat(64)
    }))
  }
}
const sender = () => Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false })
function call(input: unknown, owner = sender()) {
  return mocks.handle.mock.calls[0][1]({ sender: owner }, input)
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.enabled.mockReturnValue(true)
  mocks.prepare.mockResolvedValue(record())
  mocks.transition.mockResolvedValue(record('catalog-active'))
  registerRuntimeEnvironmentReconciliationHandlers({
    getUserDataPath: () => '/profile',
    retireControlTransport: retire
  })
})

it.each(['prepare', 'activate'])(
  'gates %s before proof, retirement, or caller listeners',
  async (action) => {
    mocks.enabled.mockReturnValue(false)
    const owner = sender()
    await expect(
      call(action === 'prepare' ? prepare : { ...selection, action }, owner)
    ).rejects.toThrow('experimental')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.transition).not.toHaveBeenCalled()
    expect(owner.listenerCount('destroyed')).toBe(0)
  }
)

it.each([
  { ...prepare, environmentIds: ['left', 'left'] },
  { ...prepare, canonicalEnvironmentId: 'third' },
  { ...prepare, requestId: 'x'.repeat(129) },
  { ...selection, action: 'force' }
])('rejects malformed or conflicting selections before touching the host', async (input) => {
  await expect(call(input)).rejects.toThrow()
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.transition).not.toHaveBeenCalled()
})

it('uses saved profile authority and returns only the parsed reconciliation record', async () => {
  const owner = sender()
  mocks.prepare.mockResolvedValue({ ...record(), endpoints: [{ deviceToken: 'secret' }] })
  await expect(
    call({ ...prepare, userDataPath: '/untrusted', deviceToken: 'injected' }, owner)
  ).resolves.toEqual({ record: record() })
  expect(mocks.prepare).toHaveBeenCalledWith('/profile', {
    selectors: ['left', 'right'],
    canonicalEnvironmentId: 'left',
    requestId: 'request',
    signal: expect.any(AbortSignal)
  })
  expect(owner.listenerCount('destroyed')).toBe(0)
})

it('binds activation to the main-owned control-only retirement callback', async () => {
  await call({ ...selection, action: 'activate', retireControlTransport: 'untrusted' })
  expect(mocks.transition).toHaveBeenCalledWith(
    '/profile',
    {
      ...selection,
      active: true,
      signal: expect.any(AbortSignal)
    },
    retire
  )
})

it('allows reverse and cancel recovery without enabling new reconciliation', async () => {
  mocks.enabled.mockReturnValue(false)
  await call({ ...selection, action: 'reverse' })
  expect(mocks.transition).toHaveBeenCalledWith(
    '/profile',
    {
      ...selection,
      active: false,
      signal: expect.any(AbortSignal)
    },
    retire
  )
  await expect(call({ ...selection, action: 'cancel' })).resolves.toEqual({ record: null })
  expect(mocks.cancel).toHaveBeenCalledWith('/profile', expect.objectContaining(selection))
  expect(mocks.prepare).not.toHaveBeenCalled()
})

it('cancels on renderer destruction and removes its listener after rejection', async () => {
  const owner = sender()
  mocks.prepare.mockImplementation(
    (_path, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  const pending = call(prepare, owner)
  const rejected = expect(pending).rejects.toThrow('caller_destroyed')
  owner.emit('destroyed')
  await rejected
  expect(owner.listenerCount('destroyed')).toBe(0)
})

it('refuses an already-destroyed renderer before entering the coordinator', async () => {
  const owner = sender()
  owner.isDestroyed = () => true
  await expect(call(prepare, owner)).rejects.toThrow('caller_destroyed')
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(owner.listenerCount('destroyed')).toBe(0)
})
