import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const mocks = vi.hoisted(() => {
  const host: { current: RemoteHostPlatform | null } = { current: null }
  const active: { current: string | null } = { current: '1.0.0' }
  return {
    census: vi.fn(),
    stop: vi.fn(),
    wake: vi.fn(),
    rebuild: vi.fn(async () => {}),
    exec: vi.fn(),
    retain: vi.fn(),
    host,
    active
  }
})

vi.mock('../../ssh/orcad-runtime-maintenance', () => ({
  withManagedOrcadLifecycle: (
    _path: string,
    _selector: string,
    run: (managed: unknown) => Promise<unknown>
  ) => run({ environment: { id: 'env-1' }, deployment: { remotePort: 7777 } })
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadEnvironment: () => ({
    environment: { id: 'env-1' },
    deployment: { remotePort: 7777 }
  }),
  resolveLinkedOrcadContext: async () => ({
    host: mocks.host.current,
    connection: {},
    remoteHome: '/Users/dev',
    activationRecord: { active: mocks.active.current }
  }),
  requireManagedOrcadInfrastructure: () => ({
    connectionManager: {
      getState: () => ({ status: 'connected' }),
      getConnection: () => ({})
    },
    targetStore: { getTarget: () => ({ id: 'ssh-1' }) }
  }),
  managedOrcadSlot: () => ({
    host: mocks.host.current,
    remoteHome: '/Users/dev',
    userDataDir: '/Users/dev/.orca'
  }),
  managedOrcadInstallDir: () => '/Users/dev/.orca-remote/orcad-1.0.0'
}))
vi.mock('../install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: async () => ({
    host: mocks.host.current,
    connection: {},
    remoteHome: '/Users/dev',
    userDataDir: '/Users/dev/.orca',
    activationRecord: { active: mocks.active.current }
  })
}))
vi.mock('../../ssh/orcad-ssh-host-transport', () => ({ sshOrcadHostTransport: (c: unknown) => c }))
vi.mock('../activation/orcad-activation-lock', () => ({
  withOrcadActivationLock: (_slot: unknown, run: (lock: unknown) => Promise<unknown>) =>
    run({ retain: mocks.retain })
}))
vi.mock('../activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: async () => ({ active: mocks.active.current })
}))
vi.mock('./orcad-managed-remote-stop', () => ({
  readRemoteOrcadManagedStopTarget: async () => ({ state: 'ready', context: { version: '1.0.0' } })
}))
vi.mock('./orcad-rollback-terminal-barrier', () => ({
  stopIncumbentBehindTerminalBarrier: mocks.stop
}))
vi.mock('./orcad-managed-wake', () => ({ wakeStoppedManagedOrcad: mocks.wake }))
vi.mock('./orcad-managed-tunnel', () => ({ rebuildOrcadManagedTunnel: mocks.rebuild }))
vi.mock('../../ssh/orcad-terminal-census-client', () => ({
  collectManagedTerminalCensus: mocks.census
}))
vi.mock('../install/orcad-remote-runtime-control', () => ({
  execOrcadRemote: mocks.exec
}))

const { readManagedOrcadLaunchSshSession, restartManagedOrcadEnvironment } =
  await import('./orcad-managed-launch-session')

const census = (liveSessions: number | null) => ({
  liveSessions,
  startedSinceActivation: liveSessions,
  daemonProtocolVersion: 1
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.host.current = getRemoteHostPlatform('darwin-arm64')
  mocks.active.current = '1.0.0'
  mocks.stop.mockResolvedValue({ state: 'retired' })
  mocks.exec.mockResolvedValue('')
  mocks.wake.mockResolvedValue({ outcome: 'started', readiness: {} })
})

describe('restartManagedOrcadEnvironment', () => {
  it.each([2, null])(
    'never stops a server while terminals run or are uncounted (%s)',
    async (n) => {
      mocks.census.mockResolvedValue(census(n))
      await expect(restartManagedOrcadEnvironment('/u', 'env-1')).resolves.toEqual({
        outcome: 'terminals-running',
        liveSessions: n
      })
      expect(mocks.stop).not.toHaveBeenCalled()
      expect(mocks.wake).not.toHaveBeenCalled()
    }
  )

  it('stops, starts from this session and follows the new port', async () => {
    mocks.census.mockResolvedValue(census(0))
    await expect(restartManagedOrcadEnvironment('/u', 'env-1')).resolves.toEqual({
      outcome: 'restarted',
      environmentId: 'env-1'
    })
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.rebuild).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('does not claim recovery when the restart’s own SSH session already ended', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.exec.mockImplementation(async (_slot: unknown, command: string) =>
      command.includes('sw_vers') ? 'EXITED\n' : ''
    )
    const result = await restartManagedOrcadEnvironment('/u', 'env-1')
    expect(result.outcome).toBe('not-restarted')
    expect(mocks.wake).toHaveBeenCalledOnce()
  })

  it('keeps the fence when the stop may still be running', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unsettled', reason: 'still stopping' })
    await restartManagedOrcadEnvironment('/u', 'env-1')
    expect(mocks.retain).toHaveBeenCalledOnce()
  })

  it('leaves a server it could not prove stopped running', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unsettled', reason: 'still stopping' })
    const result = await restartManagedOrcadEnvironment('/u', 'env-1')
    expect(result).toEqual({ outcome: 'not-restarted', reason: 'still stopping' })
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('starts the server again but keeps the warning when the daemon was not retired', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unproven', reason: 'a terminal started' })
    const result = await restartManagedOrcadEnvironment('/u', 'env-1')
    expect(result.outcome).toBe('not-restarted')
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.rebuild).toHaveBeenCalledOnce()
  })
})

describe('readManagedOrcadLaunchSshSession', () => {
  it('probes a macOS host’s active slot', async () => {
    mocks.exec.mockResolvedValue('EXITED\n')
    await expect(readManagedOrcadLaunchSshSession('/u', 'env-1')).resolves.toBe('exited')
  })

  it('runs nothing on a Linux host', async () => {
    mocks.host.current = getRemoteHostPlatform('linux-x64')
    await expect(readManagedOrcadLaunchSshSession('/u', 'env-1')).resolves.toBe('not-applicable')
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
