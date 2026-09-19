import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { registerOrcadOutgoingRecoveryHandlers } from './orcad-outgoing-recovery-handlers'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  list: vi.fn(),
  recover: vi.fn(),
  prepare: vi.fn(),
  enabled: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/orcad-outgoing-recovery-selection', () => ({
  listOutgoingOrcadRecoveryCandidates: mocks.list,
  recoverSelectedOutgoingOrcadCapture: mocks.recover
}))
vi.mock('../ssh/orcad-outgoing-terminal-preparation', () => ({
  prepareOutgoingOrcadTerminalFromProvider: mocks.prepare
}))
vi.mock('../../shared/pty-ownership-transfer-release-gate', () => ({
  isPtyOwnershipTransferMutationEnabled: mocks.enabled
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.enabled.mockReturnValue(true)
  registerOrcadOutgoingRecoveryHandlers(() => '/profile')
})

const preparation = {
  selector: 'destination',
  ptyId: 'ssh:source@@pty',
  surfaceBinding: {
    executionHostId: 'local',
    workspaceKey: 'folder:folder',
    tabId: 'tab',
    leafId: '11111111-1111-4111-8111-111111111111',
    ptyId: 'pty'
  }
}
const assertSurface = vi.fn()
const runtime = {
  serializeSshPtyOwnershipCapture: vi.fn(),
  bindOutgoingSshPtySurface: vi.fn(() => assertSurface)
}
function registerPreparation() {
  mocks.handle.mockClear()
  runtime.bindOutgoingSshPtySurface.mockReturnValue(assertSurface)
  registerOrcadOutgoingRecoveryHandlers(() => '/profile', runtime)
}
it('starts the provider-owned preparation with main authority and returns no credentials', async () => {
  registerPreparation()
  const owner = sender()
  mocks.prepare.mockResolvedValue({
    identity: { bridgeId: 'bridge', ownerLease: 'secret' },
    outcome: 'published',
    source: { credential: 'secret' }
  })
  await expect(
    handler('prepareOrcadOutgoingTerminal')(
      { sender: owner },
      {
        ...preparation,
        runtime: 'untrusted',
        userDataPath: '/untrusted',
        identity: { ownerLease: 'injected' }
      }
    )
  ).resolves.toEqual({ bridgeId: 'bridge', outcome: 'published' })
  expect(mocks.prepare).toHaveBeenCalledWith('/profile', {
    ...preparation,
    runtime,
    signal: expect.any(AbortSignal),
    assertSurface
  })
  expect(owner.listenerCount('destroyed')).toBe(0)
})
it.each(['gate', 'runtime', 'route', 'surface', 'destroyed'])(
  'refuses preparation with invalid %s before calling the coordinator',
  async (reason) => {
    if (reason !== 'runtime') {
      registerPreparation()
    }
    const owner = sender()
    const args = structuredClone(preparation)
    if (reason === 'gate') {
      mocks.enabled.mockReturnValue(false)
    }
    if (reason === 'route') {
      args.ptyId = 'local-pty'
    }
    if (reason === 'surface') {
      args.surfaceBinding.ptyId = 'other'
    }
    if (reason === 'destroyed') {
      owner.isDestroyed = () => true
    }
    await expect(handler('prepareOrcadOutgoingTerminal')({ sender: owner }, args)).rejects.toThrow()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(owner.listenerCount('destroyed')).toBe(0)
  }
)
it('cancels in-flight preparation on sender destruction and releases its listener', async () => {
  registerPreparation()
  const owner = sender()
  mocks.prepare.mockImplementation(
    (_path, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  const pending = handler('prepareOrcadOutgoingTerminal')({ sender: owner }, preparation)
  const rejected = expect(pending).rejects.toThrow('caller_destroyed')
  owner.emit('destroyed')
  await rejected
  expect(owner.listenerCount('destroyed')).toBe(0)
})
function handler(name: string) {
  return mocks.handle.mock.calls.find(([channel]) => channel === `runtimeEnvironments:${name}`)![1]
}
function sender() {
  return Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false })
}

it('validates selection before recovery and installs no caller listener on invalid input', async () => {
  const owner = sender()
  await expect(
    handler('recoverOrcadOutgoingCapture')({ sender: owner }, { selector: '', bridgeId: 'bridge' })
  ).rejects.toThrow()
  expect(owner.listenerCount('destroyed')).toBe(0)
  expect(mocks.recover).not.toHaveBeenCalled()
})
it('lists saved captures through the profile-bound read path', () => {
  mocks.list.mockReturnValue([])
  expect(handler('listOrcadOutgoingCaptures')({}, { selector: ' destination ' })).toEqual([])
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith('/profile', 'destination', undefined)
})
it('cancels recovery when its renderer is destroyed and removes the listener', async () => {
  const owner = sender()
  mocks.recover.mockImplementation(
    (_path, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  const pending = handler('recoverOrcadOutgoingCapture')(
    { sender: owner },
    { selector: 'destination', bridgeId: 'bridge' }
  )
  const rejected = expect(pending).rejects.toThrow('caller_destroyed')
  owner.emit('destroyed')
  await rejected
  expect(owner.listenerCount('destroyed')).toBe(0)
})
it('removes its listener after successful recovery', async () => {
  const owner = sender()
  mocks.recover.mockResolvedValue({ bridgeId: 'bridge', outcome: 'published' })
  await expect(
    handler('recoverOrcadOutgoingCapture')(
      { sender: owner },
      { selector: 'destination', bridgeId: 'bridge' }
    )
  ).resolves.toEqual({ bridgeId: 'bridge', outcome: 'published' })
  expect(owner.listenerCount('destroyed')).toBe(0)
})
it('accepts preparation opt-in and injects the runtime rather than accepting renderer authority', async () => {
  const runtime = { serializeSshPtyOwnershipCapture: vi.fn() }
  mocks.handle.mockClear()
  registerOrcadOutgoingRecoveryHandlers(() => '/profile', runtime)
  handler('listOrcadOutgoingCaptures')({}, { selector: 'destination', includePreparations: true })
  expect(mocks.list).toHaveBeenCalledWith('/profile', 'destination', true)
  await handler('recoverOrcadOutgoingCapture')(
    { sender: sender() },
    { selector: 'destination', bridgeId: 'bridge', stage: 'preparation', runtime: 'untrusted' }
  )
  expect(mocks.recover).toHaveBeenCalledWith(
    '/profile',
    expect.objectContaining({ stage: 'preparation', runtime })
  )
})
