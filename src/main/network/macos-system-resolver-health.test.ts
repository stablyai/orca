import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import {
  classifyMacSystemResolverHealth,
  readCurrentProcessMacSystemResolverHealth
} from './macos-system-resolver-health'
import type { ChildProcessWithoutNullStreams } from 'child_process'

vi.mock('child_process', () => ({
  spawn: vi.fn()
}))

function mockPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
}

function createMockScutilProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams['kill']
  return child
}

beforeEach(() => {
  vi.useRealTimers()
  vi.mocked(spawn).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('classifyMacSystemResolverHealth', () => {
  it('treats the macOS no-resolver output as unhealthy', () => {
    expect(classifyMacSystemResolverHealth('No DNS configuration available\n')).toBe('unhealthy')
  })

  it('treats scutil DNS output with nameservers as healthy', () => {
    expect(
      classifyMacSystemResolverHealth(`
DNS configuration

resolver #1
  nameserver[0] : 1.1.1.1
  flags    : Request A records
`)
    ).toBe('healthy')
  })

  it('fails open when the resolver output is inconclusive', () => {
    expect(classifyMacSystemResolverHealth('')).toBe('unknown')
  })
})

describe('readCurrentProcessMacSystemResolverHealth', () => {
  it('fails open without spawning scutil outside macOS', async () => {
    mockPlatform('linux')

    await expect(readCurrentProcessMacSystemResolverHealth()).resolves.toBe('unknown')

    expect(spawn).not.toHaveBeenCalled()
  })

  it('reads scutil asynchronously so the daemon event loop can keep serving PTYs', async () => {
    mockPlatform('darwin')
    const child = createMockScutilProcess()
    vi.mocked(spawn).mockReturnValue(child)
    let settled = false

    const healthPromise = readCurrentProcessMacSystemResolverHealth().then((health) => {
      settled = true
      return health
    })
    const timerFired = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0))

    await expect(timerFired).resolves.toBe(true)
    expect(settled).toBe(false)
    expect(spawn).toHaveBeenCalledWith('/usr/sbin/scutil', ['--dns'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout.emit(
      'data',
      `
DNS configuration

resolver #1
  nameserver[0] : 1.1.1.1
`
    )
    child.emit('close', 0)

    await expect(healthPromise).resolves.toBe('healthy')
  })

  it('settles at the timeout even if scutil has not closed yet', async () => {
    vi.useFakeTimers()
    mockPlatform('darwin')
    const child = createMockScutilProcess()
    vi.mocked(spawn).mockReturnValue(child)

    const healthPromise = readCurrentProcessMacSystemResolverHealth()

    await vi.advanceTimersByTimeAsync(1_500)

    await expect(healthPromise).resolves.toBe('unknown')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('removes scutil listeners when the timeout settles before child close', async () => {
    vi.useFakeTimers()
    mockPlatform('darwin')
    const child = createMockScutilProcess()
    vi.mocked(spawn).mockReturnValue(child)

    const healthPromise = readCurrentProcessMacSystemResolverHealth()

    expect(child.stdout.listenerCount('data')).toBe(1)
    expect(child.stderr.listenerCount('data')).toBe(1)
    expect(child.listenerCount('error')).toBe(1)
    expect(child.listenerCount('close')).toBe(1)

    await vi.advanceTimersByTimeAsync(1_500)
    await expect(healthPromise).resolves.toBe('unknown')

    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('removes scutil listeners when the child closes normally', async () => {
    mockPlatform('darwin')
    const child = createMockScutilProcess()
    vi.mocked(spawn).mockReturnValue(child)

    const healthPromise = readCurrentProcessMacSystemResolverHealth()

    child.stdout.emit(
      'data',
      `
DNS configuration

resolver #1
  nameserver[0] : 1.1.1.1
`
    )
    child.emit('close', 0)

    await expect(healthPromise).resolves.toBe('healthy')
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })
})
