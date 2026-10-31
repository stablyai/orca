import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSpawnDispatch } from '../../shared/__fixtures__/fake-spawned-child'
import {
  openComputerUsePermissions,
  resetComputerUsePermissions
} from './macos-computer-use-permissions'
import { getComputerUsePermissionStatus } from './macos-computer-use-permission-status'
import type * as permissionStatusGateModule from './macos-computer-use-permission-status-gate'
import {
  createPermissionStatusGate,
  type PermissionStatusGate
} from './macos-computer-use-permission-status-gate'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())
const permissionStatusTempDir = '/tmp/orca-computer-use-permissions-test'
const helperAppPath = '/Applications/Orca Computer Use.app'
const helperInfoPlistPath = join(helperAppPath, 'Contents', 'Info.plist')

const plistBuddyStdout = vi.hoisted(() => ({ value: 'com.example.orca.computer-use\n' }))
let monotonicOffset = 0
const gate = vi.hoisted((): { current: PermissionStatusGate | null } => ({ current: null }))

// A fresh gate per test so one test's floor or cached grant never leaks into the next.
vi.mock('./macos-computer-use-permission-status-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof permissionStatusGateModule>()),
  computerUsePermissionStatusGate: {
    read: () => gate.current!.read(),
    peek: () => gate.current!.peek(),
    invalidate: () => gate.current!.invalidate()
  }
}))

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
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
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation(
        fakeSpawnDispatch((program) => ({
          stdout: program === '/usr/libexec/PlistBuddy' ? plistBuddyStdout.value : ''
        }))
      )
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
    // Fake timers restart the monotonic clock; step past any earlier test's setup window.
    vi.useFakeTimers()
    vi.advanceTimersByTime((monotonicOffset += 600_000))
    gate.current = createPermissionStatusGate(getComputerUsePermissionStatus)
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
      launchQueued: false,
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
      launchQueued: false,
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
      launchQueued: false,
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
    vi.mocked(readFile).mockResolvedValueOnce(
      '{"accessibility":"not-granted","screenshots":"not-granted"}'
    )
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
    // Keep resets asynchronous so helper commands cannot block the main process.
    expect(spawnSync).not.toHaveBeenCalledWith(
      '/usr/bin/tccutil',
      expect.anything(),
      expect.anything()
    )
  })
})

describe('setup helper launch window', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation(fakeSpawnDispatch(() => ({})))
    vi.mocked(spawnSync).mockClear()
    vi.mocked(mkdtemp).mockResolvedValue(permissionStatusTempDir)
    vi.mocked(stat).mockResolvedValue({} as Awaited<ReturnType<typeof stat>>)
    resolveHelperAppPathMock.mockReturnValue(helperAppPath)
    resolveHelperExecutablePathMock.mockReturnValue(
      `${helperAppPath}/Contents/MacOS/orca-computer-use-macos`
    )
    mockPermissionStatus('{"accessibility":"not-granted","screenshots":"not-granted"}')
    setPlatform('darwin')
    vi.useFakeTimers()
    vi.advanceTimersByTime((monotonicOffset += 600_000))
    gate.current = createPermissionStatusGate(getComputerUsePermissionStatus)
  })

  afterEach(async () => {
    // Drain any queued launch so it cannot carry into the next test.
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    setPlatform(originalPlatform)
  })

  const setupLaunches = (): string[][] =>
    vi
      .mocked(spawn)
      .mock.calls.filter(
        ([program, args]) =>
          program === '/usr/bin/open' &&
          Array.isArray(args) &&
          !args.includes('--permission-status-file')
      )
      .map(([, args]) => (Array.isArray(args) ? args.slice(3) : []))

  const setupKills = (): number =>
    vi.mocked(spawnSync).mock.calls.filter(([program]) => program === '/usr/bin/pkill').length

  it('launches once per window across permission keys and queues the latest request', async () => {
    const results = await Promise.all([
      openComputerUsePermissions('accessibility'),
      openComputerUsePermissions('screenshots'),
      openComputerUsePermissions()
    ])
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
    expect(results.map((result) => result.launchQueued)).toEqual([false, true, true])
    expect(results[1]).toMatchObject({ openedSettings: false, launchedHelper: true })

    await vi.advanceTimersByTimeAsync(4_999)
    expect(setupLaunches()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(setupLaunches()).toEqual([['--permission', 'accessibility'], ['--permissions']])
  })

  it('re-shows the helper on a second Open by killing and relaunching it after the window', async () => {
    await openComputerUsePermissions('accessibility')
    const killsAfterFirst = setupKills()
    await expect(openComputerUsePermissions('accessibility')).resolves.toMatchObject({
      launchQueued: true
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(setupLaunches()).toEqual([
      ['--permission', 'accessibility'],
      ['--permission', 'accessibility']
    ])
    expect(setupKills()).toBe(killsAfterFirst * 2)
  })

  it('reuses the status it already has instead of probing again for setup', async () => {
    await gate.current!.read()
    await openComputerUsePermissions('accessibility')
    const statusLaunches = vi
      .mocked(spawn)
      .mock.calls.filter(
        ([, args]) => Array.isArray(args) && args.includes('--permission-status-file')
      )
    expect(statusLaunches).toHaveLength(1)
  })

  it('keeps latest-wins when a later request coalesces onto an earlier one (A, B, A)', async () => {
    await openComputerUsePermissions()
    await Promise.all([
      openComputerUsePermissions('accessibility'),
      openComputerUsePermissions('screenshots'),
      openComputerUsePermissions('accessibility')
    ])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(setupLaunches()).toEqual([['--permissions'], ['--permission', 'accessibility']])
  })

  it('lets an A that arrives after A launches queue and win over B', async () => {
    await openComputerUsePermissions()
    await vi.advanceTimersByTimeAsync(5_000)
    const first = openComputerUsePermissions('accessibility')
    const second = openComputerUsePermissions('screenshots')
    while (setupLaunches().length < 2) {
      await Promise.resolve()
    }
    const third = openComputerUsePermissions('accessibility')
    await Promise.all([first, second, third])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(setupLaunches().slice(1)).toEqual([
      ['--permission', 'accessibility'],
      ['--permission', 'accessibility']
    ])
  })

  it('spawns concurrent same-permission Opens once per window', async () => {
    await Promise.all(Array.from({ length: 5 }, () => openComputerUsePermissions('accessibility')))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })

  it('never fires a queued setup spawn early when the timer delay is fractional', async () => {
    const spawnedAt: number[] = []
    vi.mocked(spawn).mockImplementation((program, args) => {
      if (program === '/usr/bin/open') {
        spawnedAt.push(performance.now())
      }
      return fakeSpawnDispatch(() => ({}))(program, Array.isArray(args) ? args : [])
    })
    await openComputerUsePermissions('accessibility')
    // Timers truncate fractional delays, so this one would fire half a millisecond early.
    vi.advanceTimersByTime(0.5)
    await openComputerUsePermissions('screenshots')
    await vi.advanceTimersByTimeAsync(6_000)
    const setupSpawns = spawnedAt.slice(-2)
    expect(setupSpawns[1]! - setupSpawns[0]!).toBeGreaterThanOrEqual(5_000)
  })

  it('spaces real setup spawns 5s apart even when pkill is slow', async () => {
    const spawnedAt: number[] = []
    let pkillDelayMs = 100
    const pkillResult: ReturnType<typeof spawnSync> = {
      pid: 0,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null
    }
    vi.mocked(spawnSync).mockImplementation(() => {
      vi.advanceTimersByTime(pkillDelayMs)
      return pkillResult
    })
    vi.mocked(spawn).mockImplementation((program, args) => {
      if (program === '/usr/bin/open') {
        spawnedAt.push(performance.now())
      }
      return fakeSpawnDispatch(() => ({}))(program, Array.isArray(args) ? args : [])
    })
    await openComputerUsePermissions('accessibility')
    pkillDelayMs = 0
    await openComputerUsePermissions('screenshots')
    await vi.advanceTimersByTimeAsync(6_000)
    const setupSpawns = spawnedAt.slice(-2)
    expect(setupSpawns).toHaveLength(2)
    expect(setupSpawns[1]! - setupSpawns[0]!).toBeGreaterThanOrEqual(5_000)
  })

  it('never serves a seeded grant after a partial reset failure', async () => {
    mockPermissionStatus('{"accessibility":"granted","screenshots":"granted"}')
    await gate.current!.read()
    vi.mocked(spawn).mockImplementation(
      fakeSpawnDispatch((program, args) =>
        program === '/usr/bin/tccutil' && args[1] === 'ScreenCapture' ? { code: 1 } : {}
      )
    )
    await expect(resetComputerUsePermissions()).rejects.toThrow('Could not reset ScreenCapture')

    mockPermissionStatus('{"accessibility":"not-granted","screenshots":"granted"}')
    const afterReset = gate.current!.read()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(afterReset).resolves.toMatchObject({
      permissions: expect.arrayContaining([{ id: 'accessibility', status: 'not-granted' }])
    })
  })
})

function mockPermissionStatus(json: string): void {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.mocked(readFile).mockResolvedValue(json)
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
