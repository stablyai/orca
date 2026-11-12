import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../../shared/computer-use-permissions-types'
import type * as PermissionsModule from './macos-computer-use-permissions'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  peek: vi.fn(),
  readBundleId: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))
vi.mock('../macos-native/macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: () => '/Applications/Orca Computer Use.app'
}))
vi.mock('./macos-computer-use-permission-status', () => ({
  getComputerUsePermissionStatus: vi.fn(),
  resolveComputerUseHelperUnavailableReason: () => null
}))
vi.mock('./macos-computer-use-permission-status-gate', () => ({
  computerUsePermissionStatusGate: { peek: mocks.peek, read: mocks.peek, invalidate: () => {} }
}))
vi.mock('../../macos-permissions/macos-tcc-reset', () => ({
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
  const { markHostShuttingDown } = await import('../../startup/quit/host-shutdown-state')
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
})
