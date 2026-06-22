import { execFileSync, spawn, spawnSync } from 'child_process'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openComputerUsePermissions,
  resetComputerUsePermissions
} from './macos-computer-use-permissions'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())
const permissionStatusTempDir = '/tmp/orca-computer-use-permissions-test'
const helperAppPath = '/Applications/Orca Computer Use.app'
const helperInfoPlistPath = join(helperAppPath, 'Contents', 'Info.plist')

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => {
    const child = {
      stdout: { off: vi.fn(), on: vi.fn(), setEncoding: vi.fn() },
      stderr: { off: vi.fn(), on: vi.fn(), setEncoding: vi.fn() },
      on: vi.fn((event: string, callback: (status: number) => void) => {
        if (event === 'close') {
          queueMicrotask(() => callback(0))
        }
        return child
      }),
      off: vi.fn(() => child),
      unref: vi.fn()
    }
    return child
  }),
  spawnSync: vi.fn()
}))

vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}))

vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: resolveHelperAppPathMock,
  resolveMacOSComputerUseExecutablePath: resolveHelperExecutablePathMock
}))

describe('openComputerUsePermissions', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.mocked(spawn).mockClear()
    vi.mocked(spawnSync).mockClear()
    vi.mocked(execFileSync).mockReset()
    vi.mocked(mkdtemp).mockReset()
    vi.mocked(readFile).mockReset()
    vi.mocked(rm).mockReset()
    vi.mocked(stat).mockReset()
    resolveHelperAppPathMock.mockReset()
    resolveHelperExecutablePathMock.mockReset()
    resolveHelperExecutablePathMock.mockReturnValue(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
    )
    vi.mocked(mkdtemp).mockResolvedValue(permissionStatusTempDir)
    vi.mocked(stat).mockResolvedValue({} as Awaited<ReturnType<typeof stat>>)
    mockPermissionStatus('{"accessibility":"granted","screenshots":"granted"}')
    setPlatform('darwin')
  })

  afterEach(() => {
    vi.useRealTimers()
    setPlatform(originalPlatform)
  })

  it('does not launch the setup helper when all permissions are granted', async () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')

    await expect(openComputerUsePermissions()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      permissionId: undefined,
      openedSettings: false,
      launchedHelper: false,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'granted' }
      ],
      nextStep: null
    })
    expect(spawn).not.toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-n', '/Applications/Orca Computer Use.app', '--args', '--permissions'],
      { detached: true, stdio: 'ignore' }
    )
  })

  it('launches the helper app in permissions mode', async () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"granted","screenshots":"not-granted"}')

    await expect(openComputerUsePermissions()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      permissionId: undefined,
      openedSettings: false,
      launchedHelper: true,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ],
      nextStep: 'Grant Screen Recording to Orca Computer Use, then retry get-app-state.'
    })
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/pkill',
      ['-f', 'orca-computer-use-macos[[:space:]]+--permission([[:space:]]|$)'],
      { stdio: 'ignore' }
    )
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/pkill',
      ['-f', 'orca-computer-use-macos[[:space:]]+--permissions([[:space:]]|$)'],
      { stdio: 'ignore' }
    )
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-n', '/Applications/Orca Computer Use.app', '--args', '--permissions'],
      { detached: true, stdio: 'ignore' }
    )
  })

  it('launches a targeted permission helper flow', async () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"not-granted","screenshots":"not-granted"}')

    await expect(openComputerUsePermissions('accessibility')).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      permissionId: 'accessibility',
      openedSettings: true,
      launchedHelper: true,
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ],
      nextStep: 'Grant Accessibility to Orca Computer Use, then retry get-app-state.'
    })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-n', '/Applications/Orca Computer Use.app', '--args', '--permission', 'accessibility'],
      { detached: true, stdio: 'ignore' }
    )
  })

  it('shares the prerequisite status probe while preserving targeted setup launches', async () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"not-granted","screenshots":"not-granted"}')

    await expect(
      Promise.all([
        openComputerUsePermissions('accessibility'),
        openComputerUsePermissions('screenshots')
      ])
    ).resolves.toHaveLength(2)

    const openCalls = vi.mocked(spawn).mock.calls.filter(([command]) => command === '/usr/bin/open')
    const statusLaunches = openCalls.filter(([, args]) =>
      (args as string[]).includes('--permission-status-file')
    )
    const accessibilityLaunches = openCalls.filter(([, args]) => {
      const helperArgs = args as string[]
      return helperArgs.includes('--permission') && helperArgs.includes('accessibility')
    })
    const screenshotsLaunches = openCalls.filter(([, args]) => {
      const helperArgs = args as string[]
      return helperArgs.includes('--permission') && helperArgs.includes('screenshots')
    })
    expect(statusLaunches).toHaveLength(1)
    expect(accessibilityLaunches).toHaveLength(1)
    expect(screenshotsLaunches).toHaveLength(1)
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/pkill',
      ['-f', 'orca-computer-use-macos[[:space:]]+--permission([[:space:]]|$)'],
      { stdio: 'ignore' }
    )
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/pkill',
      ['-f', 'orca-computer-use-macos[[:space:]]+--permissions([[:space:]]|$)'],
      { stdio: 'ignore' }
    )

    const setupLaunchOrders = vi.mocked(spawn).mock.invocationCallOrder.filter((_, index) => {
      const args = vi.mocked(spawn).mock.calls[index]?.[1] as string[] | undefined
      return args?.includes('--permission')
    })
    const pkillCalls = vi.mocked(spawnSync).mock.calls
    for (const setupLaunchOrder of setupLaunchOrders) {
      const priorPkillPatterns = vi
        .mocked(spawnSync)
        .mock.invocationCallOrder.flatMap((order, index) => {
          const pattern = pkillCalls[index]?.[1]?.[1]
          return order < setupLaunchOrder && pattern ? [pattern] : []
        })
      expect(priorPkillPatterns).toContain(
        'orca-computer-use-macos[[:space:]]+--permission([[:space:]]|$)'
      )
      expect(priorPkillPatterns).toContain(
        'orca-computer-use-macos[[:space:]]+--permissions([[:space:]]|$)'
      )
    }
  })

  it('launches a targeted permission helper even when that permission is already granted', async () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"granted","screenshots":"not-granted"}')

    await expect(openComputerUsePermissions('accessibility')).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      permissionId: 'accessibility',
      openedSettings: true,
      launchedHelper: true,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ],
      nextStep: 'Grant Screen Recording to Orca Computer Use, then retry get-app-state.'
    })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-n', '/Applications/Orca Computer Use.app', '--args', '--permission', 'accessibility'],
      { detached: true, stdio: 'ignore' }
    )
  })

  it('returns a no-op result on non-macOS platforms', async () => {
    setPlatform('linux')

    await expect(openComputerUsePermissions()).resolves.toEqual({
      platform: 'linux',
      helperAppPath: null,
      permissionId: undefined,
      openedSettings: false,
      launchedHelper: false,
      permissions: [
        { id: 'accessibility', status: 'unsupported' },
        { id: 'screenshots', status: 'unsupported' }
      ],
      nextStep: null
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('throws when the helper app is missing on macOS', async () => {
    resolveHelperAppPathMock.mockReturnValue(null)

    await expect(openComputerUsePermissions()).rejects.toThrow(
      'Orca Computer Use.app was not found'
    )
  })

  it('throws when the helper executable is missing during setup', async () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    resolveHelperExecutablePathMock.mockReturnValue(null)

    await expect(openComputerUsePermissions('accessibility')).rejects.toThrow(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos was not found'
    )
  })

  it('resets stale macOS TCC grants for the helper bundle id', async () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    vi.mocked(readFile)
      .mockResolvedValueOnce('{"accessibility":"granted","screenshots":"granted"}')
      .mockResolvedValueOnce('{"accessibility":"not-granted","screenshots":"not-granted"}')
    vi.mocked(execFileSync).mockReturnValueOnce('com.example.orca.computer-use\n')
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    await expect(resetComputerUsePermissions()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      helperUnavailableReason: null,
      bundleId: 'com.example.orca.computer-use',
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', helperInfoPlistPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/tccutil',
      ['reset', 'Accessibility', 'com.example.orca.computer-use'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/tccutil',
      ['reset', 'ScreenCapture', 'com.example.orca.computer-use'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  })
})

function mockPermissionStatus(json: string): void {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.mocked(readFile).mockResolvedValue(json)
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
