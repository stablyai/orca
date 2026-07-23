import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeBoundedFileReader from '../../shared/node-bounded-file-reader'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())
const permissionStatusTempDir = '/tmp/orca-computer-use-permissions-test'
const permissionStatusPath = join(permissionStatusTempDir, 'status.json')
const { readNodeFileWithinLimitMock } = vi.hoisted(() => ({
  readNodeFileWithinLimitMock: vi.fn()
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
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeBoundedFileReader>()
  return { ...actual, readNodeFileWithinLimit: readNodeFileWithinLimitMock }
})

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
    readNodeFileWithinLimitMock.mockReset()
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

  it('kills the helper and rejects oversized launch output', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
      stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    child.kill = vi.fn()
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)

    const statusPromise = getComputerUsePermissionStatus()
    await Promise.resolve()
    child.stdout.emit('data', 'x'.repeat(64 * 1024 + 1))

    await expect(statusPromise).rejects.toMatchObject({
      name: 'RuntimeClientError',
      code: 'accessibility_error',
      message: 'Permission helper returned too much launch output'
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('preserves helper diagnostics delivered as 50,000 one-byte fragments', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
      stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    child.kill = vi.fn()
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)
    const statusPromise = getComputerUsePermissionStatus()
    await Promise.resolve()

    for (let index = 0; index < 50_000; index += 1) {
      child.stderr.emit('data', ' ')
    }
    child.stderr.emit('data', 'permission denied')
    child.emit('close', 1)

    await expect(statusPromise).rejects.toMatchObject({
      code: 'accessibility_error',
      message: 'Could not check permissions: permission denied'
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
    expect(readNodeFileWithinLimitMock).toHaveBeenCalledWith(permissionStatusPath, 64 * 1024)
    expect(rm).toHaveBeenCalledWith(permissionStatusTempDir, {
      recursive: true,
      force: true
    })
  })

  it('maps an oversized permission status file to a stable runtime error', async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    readNodeFileWithinLimitMock.mockRejectedValueOnce(
      new nodeBoundedFileReader.NodeFileReadTooLargeError(64 * 1024 + 1, 64 * 1024)
    )

    await expect(getComputerUsePermissionStatus()).rejects.toMatchObject({
      name: 'RuntimeClientError',
      code: 'accessibility_error',
      message: 'Permission helper returned too much status data'
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
  readNodeFileWithinLimitMock.mockResolvedValue({
    buffer: Buffer.from(json),
    stats: { size: Buffer.byteLength(json) }
  })
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
