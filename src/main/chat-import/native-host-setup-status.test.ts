import { afterEach, describe, expect, it } from 'vitest'
import { detectBrowserSetup } from './native-host-setup-status'

const base = {
  browser: 'chrome' as const,
  platform: 'darwin' as NodeJS.Platform,
  homeDir: '/Users/u',
  userDataPath: '/data'
}

describe('detectBrowserSetup', () => {
  it('detected when the browser user-data dir exists', () => {
    const r = detectBrowserSetup({
      ...base,
      exists: (p) => p.includes('Google/Chrome'),
      registryHas: () => false
    })
    expect(r.detected).toBe(true)
  })

  it('hostInstalled (posix) when the manifest file exists', () => {
    const r = detectBrowserSetup({
      ...base,
      exists: (p) => p.endsWith('com.orca.chatimport.json'),
      registryHas: () => false
    })
    expect(r.hostInstalled).toBe(true)
  })

  it('hostInstalled (win32) uses the registry, not the file', () => {
    const r = detectBrowserSetup({
      ...base,
      platform: 'win32',
      exists: () => false,
      registryHas: (k) => k.includes('NativeMessagingHosts')
    })
    expect(r.hostInstalled).toBe(true)
  })

  it('neither when nothing exists', () => {
    const r = detectBrowserSetup({ ...base, exists: () => false, registryHas: () => false })
    expect(r).toEqual({ detected: false, hostInstalled: false })
  })

  // Task 2 review follow-up: browserUserDataDir's win32 (%LOCALAPPDATA%)
  // branch was untested. Exercise it here via detectBrowserSetup's `detected`
  // check, capturing the exact path handed to the injected `exists`.
  describe('win32 %LOCALAPPDATA% branch', () => {
    const originalLocalAppData = process.env.LOCALAPPDATA

    afterEach(() => {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData
      }
    })

    it('falls back to homeDir/AppData/Local when LOCALAPPDATA is unset', () => {
      delete process.env.LOCALAPPDATA
      let capturedPath = ''
      const r = detectBrowserSetup({
        ...base,
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        exists: (p) => {
          capturedPath = p
          return true
        },
        registryHas: () => false
      })
      expect(r.detected).toBe(true)
      const normalized = capturedPath.replace(/\\/g, '/')
      expect(normalized).toContain('AppData/Local')
      expect(normalized).toContain('Google/Chrome/User Data')
    })

    it('uses LOCALAPPDATA when set', () => {
      process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local'
      let capturedPath = ''
      const r = detectBrowserSetup({
        ...base,
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        exists: (p) => {
          capturedPath = p
          return true
        },
        registryHas: () => false
      })
      expect(r.detected).toBe(true)
      const normalized = capturedPath.replace(/\\/g, '/')
      expect(normalized).toContain('AppData/Local')
      expect(normalized).toContain('Google/Chrome/User Data')
    })
  })
})
