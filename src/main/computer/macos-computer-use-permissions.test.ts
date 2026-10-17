import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openComputerUsePermissions,
  resetComputerUsePermissions
} from './macos-computer-use-permissions'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())
const callPermissionStatusMock = vi.hoisted(() => vi.fn())
const helperAppPath = '/Applications/Orca Computer Use.app'
const helperInfoPlistPath = join(helperAppPath, 'Contents', 'Info.plist')

// The tccutil reset and the bundle-id read now run through `runProcess`, so the fake child has to
// be one that promise settles on: stdout, then `close`.
const plistBuddyStdout = vi.hoisted(() => ({ value: 'com.example.orca.computer-use\n' }))

function fakeChild(stdout: string): Record<string, unknown> {
  const stdoutData: ((chunk: Buffer) => void)[] = []
  const finish = (callback: (status: number, signal: null) => void): void => {
    queueMicrotask(() => {
      for (const onData of stdoutData) {
        onData(Buffer.from(stdout))
      }
      callback(0, null)
    })
  }
  const child: Record<string, unknown> = {
    pid: 4242,
    stdin: { end: vi.fn(), on: vi.fn() },
    stdout: {
      on: vi.fn((event: string, callback: (chunk: Buffer) => void) => {
        if (event === 'data') {
          stdoutData.push(callback)
        }
      }),
      off: vi.fn(),
      setEncoding: vi.fn()
    },
    stderr: { on: vi.fn(), off: vi.fn(), setEncoding: vi.fn() },
    on: vi.fn((event: string, callback: (status: number, signal: null) => void) => {
      if (event === 'close') {
        finish(callback)
      }
      return child
    }),
    once: vi.fn((event: string, callback: (status: number, signal: null) => void) => {
      if (event === 'close') {
        finish(callback)
      }
      return child
    }),
    off: vi.fn(() => child),
    kill: vi.fn(),
    unref: vi.fn()
  }
  return child
}

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn((file: string) =>
    fakeChild(file === '/usr/libexec/PlistBuddy' ? plistBuddyStdout.value : '')
  ),
  spawnSync: vi.fn()
}))

vi.mock('./sidecar-client', () => ({
  callComputerSidecarPermissionStatus: callPermissionStatusMock
}))

vi.mock('./macos-native-provider-transport', () => ({ isMacOS14OrNewer: () => true }))

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
    callPermissionStatusMock.mockReset()
    resolveHelperAppPathMock.mockReset()
    resolveHelperExecutablePathMock.mockReset()
    resolveHelperExecutablePathMock.mockReturnValue(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
    )
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
    // The preliminary status read goes to the provider, so the setup window is the only launch.
    expect(
      vi.mocked(spawn).mock.calls.filter(([program]) => program === '/usr/bin/open')
    ).toHaveLength(1)
    expect(callPermissionStatusMock).toHaveBeenCalledWith(false)
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
    callPermissionStatusMock
      .mockResolvedValueOnce({ accessibility: 'granted', screenshots: 'granted' })
      .mockResolvedValueOnce({ accessibility: 'not-granted', screenshots: 'not-granted' })
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
    // Argv is asserted exactly; the options belong to the shared spawn chokepoint these now run
    // through, which owns and tests them.
    const throughChokepoint = expect.objectContaining({ shell: false, windowsHide: true })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', helperInfoPlistPath],
      throughChokepoint
    )
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/tccutil',
      ['reset', 'Accessibility', 'com.example.orca.computer-use'],
      throughChokepoint
    )
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/tccutil',
      ['reset', 'ScreenCapture', 'com.example.orca.computer-use'],
      throughChokepoint
    )
    // Why: the provider read before the reset holds the old grant; the answer must come from a new one.
    expect(callPermissionStatusMock.mock.calls).toEqual([[false], [true]])
    expect(spawn).not.toHaveBeenCalledWith('/usr/bin/open', expect.anything(), expect.anything())
    // Why: a sync reset would hold main's event loop for both children.
    expect(spawnSync).not.toHaveBeenCalledWith(
      '/usr/bin/tccutil',
      expect.anything(),
      expect.anything()
    )
  })
})

function mockPermissionStatus(json: string): void {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  callPermissionStatusMock.mockResolvedValue(JSON.parse(json))
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
