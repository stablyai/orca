import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupHiddenRateLimitPty,
  getActiveHiddenRateLimitPtyCount,
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

  it('disposes listeners before closing the hidden probe lease', () => {
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
    expect(term.destroy).not.toHaveBeenCalled()
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
})
