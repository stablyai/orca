import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  adapters: vi.fn(),
  current: vi.fn(),
  restart: vi.fn(),
  probe: vi.fn()
}))
vi.mock('./daemon-provider-state', () => ({ getDaemonProvider: mocks.provider }))
vi.mock('./daemon-provider-routing', () => ({
  getAllDaemonAdapters: mocks.adapters,
  getCurrentDaemonAdapter: mocks.current
}))
vi.mock('./daemon-provider-restart', () => ({
  replaceCurrentDaemonAfterVerifiedShutdown: mocks.restart
}))
vi.mock('./daemon-endpoint-probe', () => ({
  probeSocketConnect: mocks.probe,
  endpointIsProvenDead: (result: string) => result === 'dead'
}))
vi.mock('./daemon-spawner', () => ({ getDaemonSocketPath: () => '/isolated-unused' }))
vi.mock('./daemon-launch-paths', () => ({ getDaemonRuntimeDir: () => '/isolated-unused' }))
vi.mock('./daemon-pty-router', () => ({
  DaemonPtyRouter: class {
    removeRecoveredLegacyAdapter = vi.fn()
  }
}))
vi.mock('./degraded-daemon-pty-provider', () => ({ DegradedDaemonPtyProvider: class {} }))
import { DaemonPtyRouter } from './daemon-pty-router'
import { restartStalledDaemon, reviewStalledDaemon } from './daemon-stalled-owner-recovery'

const owner = { protocolVersion: 50, pid: 123, startedAtMs: 456, launchNonce: 'original' }
const sessions = [{ sessionId: 'terminal', incarnationId: 'first', cwd: '/workspace', pid: 789 }]
const adapter = {
  protocolVersion: 50,
  getDaemonIdentity: vi.fn(),
  getAsyncIoHealth: vi.fn(),
  listSessions: vi.fn(),
  shutdownStalledOwner: vi.fn(),
  disconnectOnly: vi.fn()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.provider.mockReturnValue({})
  mocks.adapters.mockReturnValue([adapter])
  mocks.current.mockReturnValue(adapter)
  mocks.probe.mockResolvedValue('dead')
  adapter.getDaemonIdentity.mockReturnValue(owner)
  adapter.getAsyncIoHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    recoverySupported: true
  })
  adapter.listSessions.mockResolvedValue(sessions)
  adapter.shutdownStalledOwner.mockResolvedValue({ status: 'restarted', killedCount: 1 })
})

it.each([
  { ...owner, pid: 999 },
  { ...owner, launchNonce: 'replacement' },
  { ...owner, startedAtMs: 999 },
  { ...owner, protocolVersion: 51 }
])('rejects stale owner before any destructive request: %j', async (stale) => {
  expect(await reviewStalledDaemon(stale)).toEqual({ status: 'refused' })
  expect(await restartStalledDaemon({ owner: stale, sessions })).toEqual({ status: 'refused' })
  expect(adapter.shutdownStalledOwner).not.toHaveBeenCalled()
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('discards review when endpoint identity changes while inventory is pending', async () => {
  adapter.listSessions.mockImplementation(async () => {
    adapter.getDaemonIdentity.mockReturnValue({ ...owner, launchNonce: 'replacement' })
    return sessions
  })
  expect(await reviewStalledDaemon(owner)).toEqual({ status: 'refused' })
})

it('discards review when provider changes while inventory is pending', async () => {
  adapter.listSessions.mockImplementation(async () => {
    mocks.provider.mockReturnValue({})
    return sessions
  })
  expect(await reviewStalledDaemon(owner)).toEqual({ status: 'refused' })
})

it('refuses an older peer without fenced recovery support', async () => {
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
  expect(await reviewStalledDaemon(owner)).toEqual({ status: 'refused' })
  expect(adapter.listSessions).not.toHaveBeenCalled()
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('refuses review when any live session lacks incarnation evidence', async () => {
  adapter.listSessions.mockResolvedValue([{ ...sessions[0], incarnationId: undefined }])
  expect(await reviewStalledDaemon(owner)).toEqual({ status: 'refused' })
})

it('does not broaden recovery when the owner rejects the reviewed inventory', async () => {
  adapter.shutdownStalledOwner.mockResolvedValue({ status: 'refused' })
  expect(await restartStalledDaemon({ owner, sessions })).toEqual({ status: 'refused' })
  expect(mocks.probe).not.toHaveBeenCalled()
  expect(mocks.restart).not.toHaveBeenCalled()
  expect(adapter.disconnectOnly).not.toHaveBeenCalled()
})

it('removes only the recovered legacy owner and never restarts the healthy current daemon', async () => {
  const provider = Reflect.construct(DaemonPtyRouter, [])
  mocks.provider.mockReturnValue(provider)
  mocks.current.mockReturnValue({})
  expect(await restartStalledDaemon({ owner, sessions })).toEqual({
    status: 'restarted',
    killedCount: 1
  })
  expect(adapter.shutdownStalledOwner).toHaveBeenCalledExactlyOnceWith({ owner, sessions })
  expect(provider.removeRecoveredLegacyAdapter).toHaveBeenCalledExactlyOnceWith(adapter)
  expect(adapter.disconnectOnly).toHaveBeenCalledOnce()
  expect(mocks.restart).not.toHaveBeenCalled()
})

it('relaunches current owner only after its fenced shutdown and dead endpoint proof', async () => {
  expect(await restartStalledDaemon({ owner, sessions })).toEqual({
    status: 'restarted',
    killedCount: 1
  })
  expect(mocks.restart).toHaveBeenCalledExactlyOnceWith(owner.pid)
  expect(adapter.shutdownStalledOwner.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.probe.mock.invocationCallOrder[0]
  )
})

it('rejects a second owner recovery while the first owner shutdown is pending', async () => {
  let release: ((value: { status: 'refused' }) => void) | undefined
  adapter.shutdownStalledOwner.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const first = restartStalledDaemon({ owner, sessions })
  expect(await restartStalledDaemon({ owner, sessions })).toEqual({ status: 'refused' })
  expect(adapter.shutdownStalledOwner).toHaveBeenCalledOnce()
  if (!release) {
    throw new Error('Shutdown was not requested')
  }
  release({ status: 'refused' })
  expect(await first).toEqual({ status: 'refused' })
})
