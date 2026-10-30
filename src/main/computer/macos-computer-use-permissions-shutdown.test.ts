import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'
import type * as PermissionsModule from './macos-computer-use-permissions'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  peek: vi.fn(),
  readBundleId: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))
vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: () => '/Applications/Orca Computer Use.app'
}))
vi.mock('./macos-computer-use-permission-status', () => ({
  getComputerUsePermissionStatus: vi.fn(),
  resolveComputerUseHelperUnavailableReason: () => null
}))
vi.mock('./macos-computer-use-permission-status-gate', () => ({
  computerUsePermissionStatusGate: { peek: mocks.peek, read: mocks.peek, invalidate: () => {} }
}))
vi.mock('../macos-tcc-reset', () => ({
  readMacosBundleId: mocks.readBundleId,
  resetMacosTccPermission: async () => ({ ok: true })
}))

const denied: ComputerUsePermissionStatusResult = {
  platform: 'darwin',
  helperAppPath: '/Applications/Orca Computer Use.app',
  helperUnavailableReason: null,
  permissions: [
    { id: 'accessibility', status: 'not-granted' },
    { id: 'screenshots', status: 'not-granted' }
  ]
}

function setupLaunches(): unknown[] {
  return mocks.spawn.mock.calls
    .filter(([program]) => program === '/usr/bin/open')
    .map(([, args]) => (Array.isArray(args) ? args.slice(3) : []))
}

function deferredStatus(): {
  promise: Promise<ComputerUsePermissionStatusResult>
  resolve: () => void
} {
  let resolve = (): void => {}
  const promise = new Promise<ComputerUsePermissionStatusResult>((settle) => {
    resolve = () => settle(denied)
  })
  return { promise, resolve }
}

// Fresh modules per test: the shutdown flag and setup window are process-wide.
async function loadModules(): Promise<{
  permissions: typeof PermissionsModule
  markHostShuttingDown: () => void
}> {
  const permissions = await import('./macos-computer-use-permissions')
  const { markHostShuttingDown } = await import('../host-shutdown-state')
  return { permissions, markHostShuttingDown }
}

describe('computer-use setup cancellation', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mocks.spawn.mockReset().mockReturnValue({ unref: () => {} })
    mocks.spawnSync.mockReset()
    mocks.peek.mockReset().mockResolvedValue(denied)
    mocks.readBundleId.mockReset().mockResolvedValue(null)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('never spawns a queued helper once the host is shutting down', async () => {
    const { permissions, markHostShuttingDown } = await loadModules()
    await permissions.openComputerUsePermissions('accessibility')
    await permissions.openComputerUsePermissions('screenshots')
    markHostShuttingDown()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })

  it('cancels an Open whose status resolves during shutdown, as an error', async () => {
    const status = deferredStatus()
    mocks.peek.mockReturnValue(status.promise)
    const { permissions, markHostShuttingDown } = await loadModules()
    const open = permissions.openComputerUsePermissions('accessibility')
    markHostShuttingDown()
    status.resolve()
    await expect(open).rejects.toThrow('cancelled')
    expect(setupLaunches()).toEqual([])
  })

  it('cancels an Open that predates a reset, and the next Open still launches', async () => {
    const status = deferredStatus()
    mocks.peek.mockReturnValueOnce(status.promise)
    const { permissions } = await loadModules()
    const stale = permissions.openComputerUsePermissions('accessibility')
    await permissions.resetComputerUsePermissions()
    const fresh = permissions.openComputerUsePermissions('accessibility')
    status.resolve()
    await expect(stale).rejects.toThrow('cancelled')
    await expect(fresh).resolves.toMatchObject({ launchedHelper: true, launchQueued: false })
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })

  it('lets the newest request win when an older one resumes after it launched', async () => {
    const status = deferredStatus()
    mocks.peek.mockReturnValueOnce(status.promise).mockReturnValueOnce(status.promise)
    const { permissions } = await loadModules()
    // A1 and B wait on a slow probe; A2 joins an answer that is already in.
    const a1 = permissions.openComputerUsePermissions('accessibility')
    const b = permissions.openComputerUsePermissions('screenshots')
    await permissions.openComputerUsePermissions('accessibility')
    status.resolve()
    await Promise.all([a1, b])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })

  it('cancels an untargeted Open during shutdown even when everything is granted', async () => {
    mocks.peek.mockResolvedValue({
      ...denied,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'granted' }
      ]
    })
    const { permissions, markHostShuttingDown } = await loadModules()
    markHostShuttingDown()
    await expect(permissions.openComputerUsePermissions()).rejects.toThrow('cancelled')
  })

  it('cancels a queued launch before reset waits on the bundle id', async () => {
    const { permissions } = await loadModules()
    await permissions.openComputerUsePermissions('accessibility')
    await permissions.openComputerUsePermissions('screenshots')
    let finishBundleRead = (): void => {}
    mocks.readBundleId.mockReturnValue(
      new Promise<null>((resolve) => {
        finishBundleRead = () => resolve(null)
      })
    )
    const reset = permissions.resetComputerUsePermissions()
    await vi.advanceTimersByTimeAsync(6_000)
    finishBundleRead()
    await reset
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })
})
