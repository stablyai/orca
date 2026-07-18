import { describe, expect, it, vi, afterEach } from 'vitest'
import os from 'node:os'
import { isConptyAvailable } from './windows-pty-backend'

describe('isConptyAvailable', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true
    })
  })

  it('returns false on non-win32 platforms', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true
    })
    expect(isConptyAvailable()).toBe(false)
  })

  it('returns true on win32 with build number >= 18309', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
    const spy = vi.spyOn(os, 'release').mockReturnValue('10.0.18309')
    expect(isConptyAvailable()).toBe(true)

    spy.mockReturnValue('10.0.19041')
    expect(isConptyAvailable()).toBe(true)
  })

  it('returns false on win32 with build number < 18309', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
    const spy = vi.spyOn(os, 'release').mockReturnValue('10.0.17763')
    expect(isConptyAvailable()).toBe(false)

    spy.mockReturnValue('6.1.7601')
    expect(isConptyAvailable()).toBe(false)
  })

  it('returns false on win32 if build number cannot be parsed', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
    vi.spyOn(os, 'release').mockReturnValue('unknown-release')
    expect(isConptyAvailable()).toBe(false)
  })
})
