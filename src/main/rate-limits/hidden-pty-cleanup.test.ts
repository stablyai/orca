import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupHiddenRateLimitPty,
  getActiveHiddenRateLimitPtyCount,
  HiddenRateLimitPtyCapacityError,
  MAX_ACTIVE_HIDDEN_RATE_LIMIT_PTYS,
  registerHiddenRateLimitPty
} from './hidden-pty-cleanup'

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

describe('cleanupHiddenRateLimitPty', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.clearAllMocks()
  })

  it('disposes listeners, kills the child, then destroys the PTY fd on POSIX', () => {
    setPlatform('darwin')
    const dataDisposable = { dispose: vi.fn() }
    const exitDisposable = { dispose: vi.fn() }
    const killMock = vi.fn()
    const term = {
      kill: killMock,
      destroy: vi.fn()
    }

    cleanupHiddenRateLimitPty(term, [dataDisposable, exitDisposable], { kill: true })

    expect(dataDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killMock.mock.invocationCallOrder[0]
    )
    expect(exitDisposable.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      killMock.mock.invocationCallOrder[0]
    )
    expect(killMock.mock.invocationCallOrder[0]).toBeLessThan(
      term.destroy.mock.invocationCallOrder[0]
    )
  })

  it('releases the PTY fd without killing again after natural exit', () => {
    setPlatform('darwin')
    const killMock = vi.fn()
    const term = {
      kill: killMock,
      destroy: vi.fn()
    }

    cleanupHiddenRateLimitPty(term, [], { kill: false })

    expect(killMock).not.toHaveBeenCalled()
    expect(term.destroy).toHaveBeenCalledTimes(1)
  })

  it('neutralizes POSIX destroy-time SIGHUP after the intentional kill', () => {
    setPlatform('linux')
    const killMock = vi.fn()
    const term = {
      kill: killMock,
      destroy: vi.fn(() => {
        term.kill('SIGHUP')
      })
    }

    cleanupHiddenRateLimitPty(term, [], { kill: true })

    expect(killMock).toHaveBeenCalledTimes(1)
    expect(killMock).toHaveBeenCalledWith()
  })

  it('does not destroy after an intentional Windows kill because destroy kills again', () => {
    setPlatform('win32')
    const term = {
      kill: vi.fn(),
      destroy: vi.fn(() => {
        term.kill()
      })
    }

    cleanupHiddenRateLimitPty(term, [], { kill: true })

    expect(term.kill).toHaveBeenCalledTimes(1)
    expect(term.destroy).not.toHaveBeenCalled()
  })

  it('destroys a Windows PTY after natural exit so ConPTY cleanup still runs', () => {
    setPlatform('win32')
    const term = {
      kill: vi.fn(),
      destroy: vi.fn(() => {
        term.kill()
      })
    }

    cleanupHiddenRateLimitPty(term, [], { kill: false })

    expect(term.kill).toHaveBeenCalledTimes(1)
    expect(term.destroy).toHaveBeenCalledTimes(1)
  })

  it('removes registered hidden PTYs when cleanup kills them', () => {
    setPlatform('darwin')
    const term = {
      kill: vi.fn(),
      destroy: vi.fn()
    }
    const registration = registerHiddenRateLimitPty(term)

    expect(getActiveHiddenRateLimitPtyCount()).toBe(1)

    cleanupHiddenRateLimitPty(term, [registration], { kill: true })

    expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
  })

  it('removes registered hidden PTYs after natural exit cleanup', () => {
    setPlatform('darwin')
    const term = {
      kill: vi.fn(),
      destroy: vi.fn()
    }
    const registration = registerHiddenRateLimitPty(term)

    expect(getActiveHiddenRateLimitPtyCount()).toBe(1)

    cleanupHiddenRateLimitPty(term, [registration], { kill: false })

    expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
  })

  it('caps active hidden PTYs, tears down overflow, and recovers after disposal', () => {
    setPlatform('darwin')
    const registrations = Array.from({ length: MAX_ACTIVE_HIDDEN_RATE_LIMIT_PTYS }, () =>
      registerHiddenRateLimitPty({ kill: vi.fn(), destroy: vi.fn() })
    )
    expect(getActiveHiddenRateLimitPtyCount()).toBe(MAX_ACTIVE_HIDDEN_RATE_LIMIT_PTYS)

    const overflowKill = vi.fn()
    const overflow = { kill: overflowKill, destroy: vi.fn() }
    expect(() => registerHiddenRateLimitPty(overflow)).toThrow(HiddenRateLimitPtyCapacityError)
    expect(overflowKill).toHaveBeenCalledOnce()
    expect(overflow.destroy).toHaveBeenCalledOnce()
    expect(getActiveHiddenRateLimitPtyCount()).toBe(MAX_ACTIVE_HIDDEN_RATE_LIMIT_PTYS)

    registrations[0]!.dispose()
    const recovered = registerHiddenRateLimitPty({ kill: vi.fn(), destroy: vi.fn() })
    expect(getActiveHiddenRateLimitPtyCount()).toBe(MAX_ACTIVE_HIDDEN_RATE_LIMIT_PTYS)

    for (const registration of registrations.slice(1)) {
      registration.dispose()
    }
    recovered.dispose()
    expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
  })
})
