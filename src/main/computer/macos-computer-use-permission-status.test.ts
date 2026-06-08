import { execFileSync, spawn, spawnSync } from 'child_process'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())
const permissionStatusTempDir = '/tmp/orca-computer-use-permissions-test'
const permissionStatusPath = join(permissionStatusTempDir, 'status.json')

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
  })
})

function mockPermissionStatus(json: string): void {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.mocked(readFile).mockResolvedValue(json)
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
