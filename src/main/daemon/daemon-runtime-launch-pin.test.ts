import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  launch: vi.fn(),
  lease: vi.fn(),
  replace: vi.fn(),
  release: vi.fn(),
  terminate: vi.fn()
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/profile' })
}))
vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin() {
      return Promise.reject(new Error('no incumbent'))
    }
    disconnect() {}
  }
}))
vi.mock('./daemon-endpoint-adoption', () => ({
  DaemonEndpointOwnershipError: class extends Error {},
  holdDaemonAdoptionLease: mocks.lease,
  reconcileDaemonPidOwnership: vi.fn()
}))
vi.mock('./daemon-launched-child', () => ({
  DaemonEndpointUnavailableError: class extends Error {},
  launchDaemonChild: mocks.launch,
  terminateLaunchedDaemonChild: mocks.terminate
}))
vi.mock('./daemon-launch-paths', () => ({
  getDaemonEntryPath: () => '/entry',
  probeDaemonSocket: async () => false
}))
vi.mock('./daemon-bun-runtime', () => ({ resolveDesktopDaemonBunRuntime: mocks.resolve }))
vi.mock('./daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: vi.fn() }))
vi.mock('./daemon-spawner', () => ({
  getDaemonPidPath: () => '/pid',
  unlinkOwnedDaemonPidFile: vi.fn()
}))
vi.mock('./daemon-replacement-preflight', () => ({ prepareDaemonReplacement: mocks.replace }))
import { createOutOfProcessLauncher } from './daemon-out-of-process-launcher'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.replace.mockResolvedValue(null)
  mocks.resolve.mockResolvedValue({
    execPath: '/bun',
    entryPath: '/entry',
    releaseLaunchPin: mocks.release
  })
  mocks.launch.mockResolvedValue({
    child: { once: vi.fn(), off: vi.fn(), exitCode: null, signalCode: null },
    identity: { pid: 10 }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})
describe('daemon runtime launch pin', () => {
  it('holds the pin through launch and authenticated readiness', async () => {
    mocks.launch.mockImplementation(async () => {
      expect(mocks.release).not.toHaveBeenCalled()
      return { child: {}, identity: { pid: 10 } }
    })
    mocks.lease.mockImplementation(async () => {
      expect(mocks.release).not.toHaveBeenCalled()
      return { shutdown: vi.fn() }
    })
    await createOutOfProcessLauncher('/profile')('/socket', '/token')
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it.each(['launch', 'lease'])('releases after %s failure', async (phase) => {
    mocks[phase === 'launch' ? 'launch' : 'lease'].mockRejectedValue(new Error('failed'))
    await expect(createOutOfProcessLauncher('/profile')('/socket', '/token')).rejects.toThrow(
      'failed'
    )
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('releases the prepared runtime pin when replacement preflight fails', async () => {
    mocks.replace.mockImplementation(
      async (options: { prepareReplacementRuntime: () => Promise<void> }) => {
        await options.prepareReplacementRuntime()
        throw new Error('replacement failed')
      }
    )
    await expect(createOutOfProcessLauncher('/profile')('/socket', '/token')).rejects.toThrow(
      'replacement failed'
    )
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('never resolves or pins runtime files when adopting a live daemon', async () => {
    const handle = { adopted: true, shutdown: vi.fn() }
    mocks.replace.mockResolvedValue(handle)
    expect(await createOutOfProcessLauncher('/profile')('/socket', '/token')).toBe(handle)
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
})
