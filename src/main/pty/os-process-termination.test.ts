import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { killOsProcessTree, isProcessAlive } from './os-process-termination'

/** Runs `fn` with `process.platform` forced to `value`, restoring the real platform afterwards. */
function withPlatform(value: NodeJS.Platform, fn: () => void): void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

/** Builds an Error carrying an errno `code` (e.g. 'ESRCH'), matching what `process.kill` throws. */
function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

afterEach(() => {
  vi.restoreAllMocks()
  execFileMock.mockReset()
})

describe('killOsProcessTree', () => {
  it('runs taskkill /T /F for the whole tree on Windows', () => {
    withPlatform('win32', () => {
      killOsProcessTree(4242)
    })
    expect(execFileMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.any(Function)
    )
  })

  it('sends SIGKILL to the pid on POSIX (no taskkill)', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    withPlatform('linux', () => {
      killOsProcessTree(4242)
    })
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('ignores non-positive-integer pids on every platform', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    withPlatform('linux', () => {
      killOsProcessTree(0)
      killOsProcessTree(-1)
      killOsProcessTree(1.5)
    })
    withPlatform('win32', () => {
      killOsProcessTree(0)
    })
    expect(killSpy).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('swallows a POSIX kill on an already-gone pid', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('ESRCH')
    })
    withPlatform('linux', () => {
      expect(() => killOsProcessTree(4242)).not.toThrow()
    })
  })

  // Why: a swallowed failure would latch the caller's escalation state forever — the exact wedged-session
  // bug this module exists to fix, re-triggered from a denied kill.
  it('reports a Windows taskkill failure through onFailure', () => {
    const failure = new Error('Access is denied')
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(failure))
    const onFailure = vi.fn()
    withPlatform('win32', () => {
      killOsProcessTree(4242, onFailure)
    })
    expect(onFailure).toHaveBeenCalledWith(failure)
  })

  it('does not call onFailure when taskkill succeeds', () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null))
    const onFailure = vi.fn()
    withPlatform('win32', () => {
      killOsProcessTree(4242, onFailure)
    })
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('treats POSIX ESRCH as success but reports other signal errors', () => {
    const onFailure = vi.fn()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('ESRCH')
    })
    withPlatform('linux', () => {
      killOsProcessTree(4242, onFailure)
    })
    expect(onFailure).not.toHaveBeenCalled()

    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('EPERM')
    })
    withPlatform('linux', () => {
      killOsProcessTree(4242, onFailure)
    })
    expect(onFailure).toHaveBeenCalledTimes(1)
  })
})

describe('isProcessAlive', () => {
  // Why: the probe must stay non-destructive — asserting the exact (pid, 0) call catches an accidental
  // signal (e.g. SIGKILL) that would silently turn a liveness check into a kill.
  it('probes with the non-destructive signal 0 and returns true on success', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(isProcessAlive(4242)).toBe(true)
    expect(killSpy).toHaveBeenCalledWith(4242, 0)
  })

  it('returns false on ESRCH (process is gone)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('ESRCH')
    })
    expect(isProcessAlive(4242)).toBe(false)
  })

  it('returns true on EPERM (exists but owned by another user)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('EPERM')
    })
    expect(isProcessAlive(4242)).toBe(true)
  })

  it('assumes alive on an ambiguous error so no false synthetic exit is produced', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errno('EINVAL')
    })
    expect(isProcessAlive(4242)).toBe(true)
  })

  it('returns false for invalid pids without probing', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-3)).toBe(false)
    expect(killSpy).not.toHaveBeenCalled()
  })
})
