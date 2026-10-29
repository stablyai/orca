import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import type * as TimersPromises from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { escapeRegex } from '../../shared/string-utils'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())
const runProcessMock = vi.hoisted(() => vi.fn())
const permissionStatusDelayMock = vi.hoisted(() =>
  vi.fn(
    (milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds)
      })
  )
)
const permissionStatusTempDir = '/tmp/orca-computer-use-permissions-test'
const permissionStatusPath = join(permissionStatusTempDir, 'status.json')

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

// The status poll's promise delay must use the fake clock this suite controls.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: permissionStatusDelayMock
}))

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
  lstat: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}))

vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: resolveHelperAppPathMock,
  resolveMacOSComputerUseExecutablePath: resolveHelperExecutablePathMock
}))

describe('getComputerUsePermissionStatus', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.mocked(spawn).mockClear()
    vi.mocked(spawnSync).mockClear()
    vi.mocked(execFileSync).mockReset()
    vi.mocked(mkdtemp).mockReset()
    vi.mocked(readFile).mockReset()
    vi.mocked(rm).mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(lstat).mockReset()
    runProcessMock.mockReset()
    permissionStatusDelayMock.mockClear()
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    resolveHelperAppPathMock.mockReset()
    resolveHelperExecutablePathMock.mockReset()
    resolveHelperAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
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

  it('wraps permission status helper launch failures', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    const child = {
      stdout: { off: vi.fn(), on: vi.fn(), setEncoding: vi.fn() },
      stderr: { off: vi.fn(), on: vi.fn(), setEncoding: vi.fn() },
      on: vi.fn((event: string, callback: (error: Error) => void) => {
        if (event === 'error') {
          queueMicrotask(() => callback(new Error('spawn ENOENT /private/path')))
        }
        return child
      }),
      off: vi.fn(() => child),
      unref: vi.fn()
    }
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)

    await expect(getComputerUsePermissionStatus()).rejects.toMatchObject({
      name: 'RuntimeClientError',
      code: 'accessibility_error',
      message: 'Could not check permissions: failed to launch helper'
    })
    expect(rm).toHaveBeenCalledWith(permissionStatusTempDir, {
      recursive: true,
      force: true
    })
    expectOnlyOwnStatusHelperStopped()
  })

  it('removes permission status helper listeners after close', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
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
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)

    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      helperUnavailableReason: null
    })

    expect(child.stdout.off).toHaveBeenCalledWith('data', expect.any(Function))
    expect(child.stderr.off).toHaveBeenCalledWith('data', expect.any(Function))
    expect(child.off).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child.off).toHaveBeenCalledWith('close', expect.any(Function))
  })

  it('times out when the permission status helper launch never closes', async () => {
    vi.useFakeTimers()
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    const child = {
      stdout: { off: vi.fn(), on: vi.fn(), setEncoding: vi.fn() },
      stderr: { off: vi.fn(), on: vi.fn(), setEncoding: vi.fn() },
      on: vi.fn(() => child),
      off: vi.fn(() => child),
      kill: vi.fn(),
      unref: vi.fn()
    }
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)

    let settled = false
    const statusPromise = getComputerUsePermissionStatus().then(
      (status) => {
        settled = true
        return status
      },
      (error: unknown) => {
        settled = true
        throw error
      }
    )
    const rejection = expect(statusPromise).rejects.toMatchObject({
      name: 'RuntimeClientError',
      code: 'accessibility_error',
      message: 'Timed out launching permission helper'
    })

    await vi.advanceTimersByTimeAsync(5000)

    expect(settled).toBe(true)
    await rejection
    expect(child.kill).toHaveBeenCalled()
    expectOnlyOwnStatusHelperStopped()
    expect(rm).toHaveBeenCalledWith(permissionStatusTempDir, {
      recursive: true,
      force: true
    })
  })

  it('reads permission status through the helper app identity', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    mockPermissionStatus('{"accessibility":"granted","screenshots":"not-granted"}')

    await expect(getComputerUsePermissionStatus()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      helperUnavailableReason: null,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/open',
      [
        '-n',
        '/Applications/Orca Computer Use.app',
        '--args',
        '--permission-status-file',
        permissionStatusPath
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    expect(spawnSync).not.toHaveBeenCalled()
    expectOnlyOwnStatusHelperStopped()
    expect(readFile).toHaveBeenCalledWith(permissionStatusPath, 'utf8')
    expect(rm).toHaveBeenCalledWith(permissionStatusTempDir, {
      recursive: true,
      force: true
    })
  })

  it('returns unavailable permission status when the helper app is missing on macOS', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    resolveHelperAppPathMock.mockReturnValue(null)

    await expect(getComputerUsePermissionStatus()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: null,
      helperUnavailableReason: 'Orca Computer Use.app was not found',
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(execFileSync).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('cleans up when the status file is invalid', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    mockPermissionStatus('{')

    await expect(getComputerUsePermissionStatus()).rejects.toBeInstanceOf(SyntaxError)

    expectOnlyOwnStatusHelperStopped()
  })

  it('cleans up when no status file arrives before the timeout', async () => {
    vi.useFakeTimers()
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
    let settled = false
    const statusPromise = getComputerUsePermissionStatus().then(
      (status) => {
        settled = true
        return status
      },
      (error: unknown) => {
        settled = true
        throw error
      }
    )
    const rejection = expect(statusPromise).rejects.toMatchObject({
      code: 'accessibility_error',
      message: 'Timed out checking permissions'
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(stat).toHaveBeenCalledTimes(1)
    expect(permissionStatusDelayMock).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    expect(stat).toHaveBeenCalledTimes(50)
    expect(permissionStatusDelayMock).toHaveBeenCalledTimes(50)
    expect(permissionStatusDelayMock.mock.calls).toEqual(Array.from({ length: 50 }, () => [100]))
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await rejection

    expect(settled).toBe(true)
    expect(stat).toHaveBeenCalledTimes(50)
    expect(permissionStatusDelayMock).toHaveBeenCalledTimes(50)
    expectOnlyOwnStatusHelperStopped()
    expect(rm).toHaveBeenCalledWith(permissionStatusTempDir, {
      recursive: true,
      force: true
    })
  })

  it('returns the status while helper cleanup is still pending', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    let finishCleanup = (): void => {}
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    runProcessMock.mockImplementation(({ program }: { program: string }) =>
      program === '/usr/bin/pkill'
        ? pendingCleanup
        : Promise.resolve({ code: 1, signal: null, stdout: '', stderr: '', timedOut: false })
    )

    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      helperUnavailableReason: null
    })
    expectOnlyOwnStatusHelperStopped()
    finishCleanup()
  })

  it('preserves the status when helper cleanup cannot start', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    runProcessMock.mockRejectedValue(new Error('spawn ENOENT'))

    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      helperUnavailableReason: null
    })
    expectOnlyOwnStatusHelperStopped()
  })

  it('shares one helper launch between concurrent checks', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')

    const [first, second] = await Promise.all([
      getComputerUsePermissionStatus(),
      getComputerUsePermissionStatus()
    ])

    expect(second).toBe(first)
    expect(spawn).toHaveBeenCalledTimes(1)
    expectOnlyOwnStatusHelperStopped()
  })

  it('targets each sequential check separately', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    const peerDirectory = `${permissionStatusTempDir}-peer`
    vi.mocked(mkdtemp)
      .mockResolvedValueOnce(permissionStatusTempDir)
      .mockResolvedValueOnce(peerDirectory)

    await getComputerUsePermissionStatus()
    await getComputerUsePermissionStatus()

    expect(pkillCalls()).toHaveLength(2)
    for (const directory of [permissionStatusTempDir, peerDirectory]) {
      expect(runProcessMock).toHaveBeenCalledWith(pkillSpec(join(directory, 'status.json')))
    }
  })

  it('reaps orphaned helpers from finished checks before launching a new one', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    const helper = '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
    const orphanDirectory = '/var/folders/xy/T/orca-computer-use-permissions-orphan'
    const liveDirectory = '/var/folders/xy/T/orca-computer-use-permissions-live'
    runProcessMock.mockImplementation(async ({ program }: { program: string }) => ({
      code: program === '/bin/ps' ? 0 : 1,
      signal: null,
      stdout:
        program === '/bin/ps'
          ? [
              `  101 ${helper} --permission-status-file ${orphanDirectory}/status.json`,
              `  102 ${helper} --permission-status-file ${liveDirectory}/status.json`,
              `  103 ${helper} --agent /tmp/orca-computer-use.sock --token-file /tmp/token`,
              `  104 ${helper} --permission-status-file /tmp/unrelated/status.json`,
              '  105 /usr/bin/some-other-process'
            ].join('\n')
          : '',
      stderr: '',
      timedOut: false
    }))
    const actualFs = await vi.importActual<typeof fsPromises>('node:fs/promises')
    vi.mocked(lstat).mockImplementation(async (path) => {
      if (path === orphanDirectory) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return actualFs.lstat('/')
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      await getComputerUsePermissionStatus()

      expect(kill).toHaveBeenCalledTimes(1)
      expect(kill).toHaveBeenCalledWith(101, 'SIGKILL')
      const psOrder = runProcessMock.mock.invocationCallOrder[0]
      expect(runProcessMock.mock.calls[0][0]).toMatchObject({ program: '/bin/ps' })
      expect(psOrder).toBeLessThan(vi.mocked(spawn).mock.invocationCallOrder[0])
    } finally {
      kill.mockRestore()
    }
  })

  it('still checks permissions when listing helpers fails', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    runProcessMock.mockImplementation(async ({ program }: { program: string }) => {
      if (program === '/bin/ps') {
        throw new Error('spawn ENOENT')
      }
      return { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
        helperUnavailableReason: null
      })
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})

function expectOnlyOwnStatusHelperStopped(): void {
  expect(pkillCalls()).toEqual([[pkillSpec(permissionStatusPath)]])
}

function pkillCalls(): unknown[][] {
  return runProcessMock.mock.calls.filter(([spec]) => spec?.program === '/usr/bin/pkill')
}

function pkillSpec(statusPath: string): unknown {
  return {
    program: '/usr/bin/pkill',
    args: [
      '-f',
      `(^|[[:space:]/])orca-computer-use-macos[[:space:]]+--permission-status-file[[:space:]]+${escapeRegex(statusPath)}$`
    ],
    timeoutMs: 2000,
    stdio: 'ignore'
  }
}

function mockPermissionStatus(json: string): void {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.mocked(readFile).mockResolvedValue(json)
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
