import { setImmediate as settleTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../../shared/computer-use-permissions-types'
import type * as PermissionsModule from './macos-computer-use-permissions'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  runProcess: vi.fn(),
  resetTcc: vi.fn(),
  peek: vi.fn(),
  readBundleId: vi.fn(),
  sessionLocked: vi.fn()
}))

vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))
vi.mock('../macos-native/macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: () => '/Applications/Orca Computer Use.app'
}))
vi.mock('./macos-computer-use-permission-status', () => ({
  getComputerUsePermissionStatus: vi.fn(),
  readMacOSSessionLocked: mocks.sessionLocked,
  resolveComputerUseHelperUnavailableReason: () => null
}))
vi.mock('./macos-computer-use-permission-status-gate', () => ({
  computerUsePermissionStatusGate: { peek: mocks.peek, read: mocks.peek, invalidate: () => {} }
}))
vi.mock('../../macos-permissions/macos-tcc-reset', () => ({
  readMacosBundleId: mocks.readBundleId,
  resetMacosTccPermission: mocks.resetTcc
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

function cleanupGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

// Fresh modules per test: the shutdown flag and setup window are process-wide.
async function loadModules(): Promise<{
  permissions: typeof PermissionsModule
  markHostShuttingDown: () => void
}> {
  const permissions = await import('./macos-computer-use-permissions')
  const { markHostShuttingDown } = await import('../../startup/quit/host-shutdown-state')
  return { permissions, markHostShuttingDown }
}

describe('computer-use setup cancellation', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    mocks.spawn.mockReset().mockReturnValue({ unref: () => {} })
    mocks.spawnSync.mockReset()
    mocks.runProcess.mockReset().mockResolvedValue({ exitCode: 0 })
    mocks.resetTcc.mockReset().mockResolvedValue({ ok: true })
    mocks.peek.mockReset().mockResolvedValue(denied)
    mocks.readBundleId.mockReset().mockResolvedValue(null)
    mocks.sessionLocked.mockReset().mockResolvedValue(false)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
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

  it.each(['screenshots', 'accessibility'] as const)(
    'delivers the latest queued %s request after the active cleanup finishes',
    async (latestPermission) => {
      const cleanup = cleanupGate()
      mocks.runProcess.mockImplementationOnce(() => cleanup.promise)
      const { permissions } = await loadModules()
      const first = permissions.openComputerUsePermissions('accessibility')
      await settleTurn()
      await permissions.openComputerUsePermissions('screenshots')
      const queued = await permissions.openComputerUsePermissions(latestPermission)
      expect(queued).toMatchObject({
        launchedHelper: true,
        launchQueued: true,
        openedSettings: false
      })
      expect(setupLaunches()).toEqual([])
      cleanup.resolve()
      await expect(first).resolves.toMatchObject({
        launchedHelper: true,
        launchQueued: false,
        openedSettings: true
      })
      expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(setupLaunches()).toEqual(
        latestPermission === 'screenshots'
          ? [
              ['--permission', 'accessibility'],
              ['--permission', 'screenshots']
            ]
          : [['--permission', 'accessibility']]
      )
    }
  )

  it('drains the complete old launch before reset and cancels older pending joiners', async () => {
    const firstCleanup = cleanupGate()
    const secondCleanup = cleanupGate()
    const olderStatus = deferredStatus()
    const events: string[] = []
    mocks.peek.mockImplementationOnce(() => olderStatus.promise)
    mocks.runProcess
      .mockImplementationOnce(async () => {
        await firstCleanup.promise
        events.push('old first closed')
      })
      .mockImplementationOnce(async () => {
        await secondCleanup.promise
        events.push('old second closed')
      })
      .mockImplementation(async () => {
        events.push('cleanup closed')
      })
    mocks.resetTcc.mockImplementation(async (service) => {
      events.push(service)
      return { ok: true }
    })
    const { permissions } = await loadModules()
    const older = permissions.openComputerUsePermissions('screenshots')
    const current = permissions.openComputerUsePermissions('accessibility')
    await settleTurn()
    olderStatus.resolve()
    await settleTurn()
    const olderCancelled = expect(older).rejects.toThrow('cancelled')
    const currentCancelled = expect(current).rejects.toThrow('cancelled')
    const reset = permissions.resetComputerUsePermissions()
    await settleTurn()
    expect(events).toEqual([])
    firstCleanup.resolve()
    await settleTurn()
    expect(events).toEqual(['old first closed'])
    expect(setupLaunches()).toEqual([])
    secondCleanup.resolve()
    await Promise.all([olderCancelled, currentCancelled, reset])
    expect(events).toEqual([
      'old first closed',
      'old second closed',
      'cleanup closed',
      'cleanup closed',
      'Accessibility',
      'ScreenCapture'
    ])
    await expect(permissions.openComputerUsePermissions('screenshots')).resolves.toMatchObject({
      launchQueued: false
    })
    expect(setupLaunches()).toEqual([['--permission', 'screenshots']])
  })

  it('joins overlapping resets while cancelling an Open between the clicks', async () => {
    const cleanup = cleanupGate()
    const events: string[] = []
    mocks.runProcess
      .mockImplementationOnce(async () => {
        await cleanup.promise
        events.push('reset first closed')
      })
      .mockImplementation(async () => {
        events.push('cleanup closed')
      })
    mocks.resetTcc.mockImplementation(async (service) => {
      events.push(service)
      return { ok: true }
    })
    const { permissions } = await loadModules()
    const first = permissions.resetComputerUsePermissions()
    const between = permissions.openComputerUsePermissions('accessibility')
    const betweenCancelled = expect(between).rejects.toThrow('cancelled')
    const second = permissions.resetComputerUsePermissions()
    const after = permissions.openComputerUsePermissions('screenshots')
    await settleTurn()
    expect(setupLaunches()).toEqual([])
    cleanup.resolve()
    await Promise.all([first, second, betweenCancelled, after])
    expect(events).toEqual([
      'reset first closed',
      'cleanup closed',
      'Accessibility',
      'ScreenCapture',
      'cleanup closed',
      'cleanup closed'
    ])
    expect(setupLaunches()).toEqual([['--permission', 'screenshots']])
  })

  it('cancels a launch whose cleanup completes during shutdown', async () => {
    const cleanup = cleanupGate()
    mocks.runProcess.mockImplementationOnce(() => cleanup.promise)
    const { permissions, markHostShuttingDown } = await loadModules()
    const open = permissions.openComputerUsePermissions('accessibility')
    await settleTurn()
    markHostShuttingDown()
    const cancelled = expect(open).rejects.toThrow('cancelled')
    cleanup.resolve()
    await cancelled
    expect(setupLaunches()).toEqual([])
  })

  it('still opens the helper when cleanup cannot start', async () => {
    mocks.runProcess.mockRejectedValueOnce(new Error('spawn failed'))
    const { permissions } = await loadModules()
    await expect(permissions.openComputerUsePermissions('accessibility')).resolves.toMatchObject({
      launchedHelper: true,
      launchQueued: false
    })
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })

  it('leaves System Settings closed when an agent asks for a granted permission', async () => {
    mocks.peek.mockResolvedValue({
      ...denied,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    const { permissions } = await loadModules()
    await expect(
      permissions.openComputerUsePermissions('accessibility', { skipGranted: true })
    ).resolves.toMatchObject({ launchedHelper: false, openedSettings: false })
    expect(setupLaunches()).toEqual([])
    await permissions.openComputerUsePermissions('screenshots', { skipGranted: true })
    expect(setupLaunches()).toEqual([['--permission', 'screenshots']])
  })

  it('refuses setup behind the lock screen without opening System Settings', async () => {
    mocks.peek.mockResolvedValue({ ...denied, sessionLocked: true })
    const { permissions } = await loadModules()
    await expect(
      permissions.openComputerUsePermissions('accessibility', { skipGranted: true })
    ).rejects.toMatchObject({ code: 'screen_locked' })
    await expect(permissions.openComputerUsePermissions()).rejects.toMatchObject({
      code: 'screen_locked'
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(setupLaunches()).toEqual([])
  })

  it('refuses setup when the screen locked after the status was read', async () => {
    mocks.peek.mockResolvedValue({
      ...denied,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'granted' }
      ],
      sessionLocked: false
    })
    mocks.sessionLocked.mockResolvedValue(true)
    const { permissions } = await loadModules()
    await expect(
      permissions.openComputerUsePermissions('accessibility', { skipGranted: true })
    ).rejects.toMatchObject({ code: 'screen_locked' })
    expect(setupLaunches()).toEqual([])
  })
})
