import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'

// Mock child_process execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

import { execFile } from 'node:child_process'
import { registerTrayWithSniWatcher } from './tray-sni-registration'

const mockExecFile = vi.mocked(execFile)

/**
 * Signature-agnostic mock implementation.
 * The promisified execFile calls the mock with (cmd, args, callback) — 3 args.
 * We extract the callback as the last argument.
 */
function makeMockImpl(behavior: (callCount: number) => { error: NodeJS.ErrnoException | null }) {
  let callCount = 0
  return (_cmd: string, _args: readonly string[] | null | undefined, ...rest: unknown[]) => {
    callCount++
    const cb = rest.at(-1) as
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined
    const { error } = behavior(callCount)
    cb?.(error, '', '')
    return {} as ChildProcess
  }
}

describe('registerTrayWithSniWatcher', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('should not call gdbus on non-linux platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    await registerTrayWithSniWatcher()

    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('should call gdbus with correct arguments on linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    mockExecFile.mockImplementation(makeMockImpl(() => ({ error: null })))

    await registerTrayWithSniWatcher()

    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [cmd, args] = mockExecFile.mock.calls[0]
    expect(cmd).toBe('gdbus')
    expect(args).toContain('--dest')
    expect(args).toContain('org.kde.StatusNotifierWatcher')
    expect(args).toContain('--method')
    expect(args).toContain('org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem')
    // Should contain the service name with current PID
    const serviceName = args![args!.length - 1]
    expect(serviceName).toMatch(/^org\.freedesktop\.StatusNotifierItem-\d+-1$/)
  })

  it('should handle ENOENT gracefully (gdbus not installed)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    mockExecFile.mockImplementation(
      makeMockImpl(() => {
        const error = new Error('spawn gdbus ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        return { error }
      })
    )

    // Should not throw
    await expect(registerTrayWithSniWatcher()).resolves.toBeUndefined()
  })

  it('should log warning for non-ENOENT errors', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mockExecFile.mockImplementation(
      makeMockImpl(() => {
        const error = new Error('some other error') as NodeJS.ErrnoException
        error.code = 'EACCES'
        return { error }
      })
    )

    await registerTrayWithSniWatcher()

    expect(consoleWarnSpy).toHaveBeenCalled()
    expect(consoleWarnSpy.mock.calls[0][0]).toContain('[tray-sni-registration]')

    consoleWarnSpy.mockRestore()
  })

  it('should retry registration after delay', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    mockExecFile.mockImplementation(
      makeMockImpl((count) => {
        if (count === 1) {
          const error = new Error('first attempt failed') as NodeJS.ErrnoException
          error.code = 'EACCES'
          return { error }
        }
        return { error: null }
      })
    )

    await registerTrayWithSniWatcher()

    // First call happens immediately
    expect(mockExecFile).toHaveBeenCalledTimes(1)

    // Advance timers to trigger retry
    await vi.advanceTimersByTimeAsync(2000)

    // Second call happens after retry
    expect(mockExecFile).toHaveBeenCalledTimes(2)
  })
})
