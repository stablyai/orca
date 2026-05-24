import { execFileSync, spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openComputerUsePermissions,
  resetComputerUsePermissions
} from './macos-computer-use-permissions'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  spawnSync: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdtempSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn()
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
    vi.mocked(existsSync).mockReset()
    vi.mocked(mkdtempSync).mockReset()
    vi.mocked(readFileSync).mockReset()
    vi.mocked(rmSync).mockReset()
    resolveHelperAppPathMock.mockReset()
    resolveHelperExecutablePathMock.mockReset()
    resolveHelperExecutablePathMock.mockReturnValue(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
    )
    vi.mocked(mkdtempSync).mockReturnValue('/tmp/orca-computer-use-permissions-test')
    vi.mocked(existsSync).mockReturnValue(true)
    mockPermissionStatus('{"accessibility":"granted","screenshots":"granted"}')
    setPlatform('darwin')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('does not launch the setup helper when all permissions are granted', () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')

    expect(openComputerUsePermissions()).toEqual({
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
    expect(spawn).not.toHaveBeenCalled()
  })

  it('launches the helper app in permissions mode', () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"granted","screenshots":"not-granted"}')

    expect(openComputerUsePermissions()).toEqual({
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
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/pkill',
      ['-f', 'orca-computer-use-macos --permission'],
      { stdio: 'ignore' }
    )
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/pkill',
      ['-f', 'orca-computer-use-macos --permissions'],
      { stdio: 'ignore' }
    )
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-n', '/Applications/Orca Computer Use.app', '--args', '--permissions'],
      { detached: true, stdio: 'ignore' }
    )
  })

  it('launches a targeted permission helper flow', () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"not-granted","screenshots":"not-granted"}')

    expect(openComputerUsePermissions('accessibility')).toEqual({
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

  it('launches a targeted permission helper even when that permission is already granted', () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"granted","screenshots":"not-granted"}')

    expect(openComputerUsePermissions('accessibility')).toEqual({
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

  it('returns a no-op result on non-macOS platforms', () => {
    setPlatform('linux')

    expect(openComputerUsePermissions()).toEqual({
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

  it('throws when the helper app is missing on macOS', () => {
    resolveHelperAppPathMock.mockReturnValue(null)

    expect(() => openComputerUsePermissions()).toThrow('Orca Computer Use.app was not found')
  })

  it('throws when the helper executable is missing during setup', () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    resolveHelperExecutablePathMock.mockReturnValue(null)

    expect(() => openComputerUsePermissions('accessibility')).toThrow(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos was not found'
    )
  })

  it('reads permission status through the helper app identity', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    mockPermissionStatus('{"accessibility":"granted","screenshots":"not-granted"}')

    expect(getComputerUsePermissionStatus()).toEqual({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      helperUnavailableReason: null,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/open',
      [
        '-n',
        '/Applications/Orca Computer Use.app',
        '--args',
        '--permission-status-file',
        '/tmp/orca-computer-use-permissions-test/status.json'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    expect(readFileSync).toHaveBeenCalledWith(
      '/tmp/orca-computer-use-permissions-test/status.json',
      'utf8'
    )
    expect(rmSync).toHaveBeenCalledWith('/tmp/orca-computer-use-permissions-test', {
      recursive: true,
      force: true
    })
  })

  it('resets stale macOS TCC grants for the helper bundle id', () => {
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    vi.mocked(readFileSync)
      .mockReturnValueOnce('{"accessibility":"granted","screenshots":"granted"}')
      .mockReturnValueOnce('{"accessibility":"not-granted","screenshots":"not-granted"}')
    vi.mocked(execFileSync).mockReturnValueOnce('com.example.orca.computer-use\n')
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    expect(resetComputerUsePermissions()).toEqual({
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
      [
        '-c',
        'Print :CFBundleIdentifier',
        '/Applications/Orca Computer Use.app/Contents/Info.plist'
      ],
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

  it('returns unavailable permission status when the helper app is missing on macOS', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    resolveHelperAppPathMock.mockReturnValue(null)

    expect(getComputerUsePermissionStatus()).toEqual({
      platform: 'darwin',
      helperAppPath: null,
      helperUnavailableReason: 'Orca Computer Use.app was not found',
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

function mockPermissionStatus(json: string): void {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.mocked(readFileSync).mockReturnValue(json)
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
