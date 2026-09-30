import { describe, expect, it, vi } from 'vitest'
import type { WebPreferences } from 'electron'

vi.mock('./browser-manager', () => ({ browserManager: { attachGuestPolicies: vi.fn() } }))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: { isAllowedPartition: (p: string) => p === 'persist:orca-browser' }
}))
vi.mock('./browser-route-session-runtime', () => ({
  browserRouteSessionRegistry: { isAllowedPartition: (p: string) => p === 'orca-route:a' },
  browserRouteWebContentsRegistry: { attachGuest: vi.fn() }
}))
vi.mock('./local-ssh-browser-partitions', () => ({
  isLocalSshBrowserPartition: (p: string) => p === 'orca-local-ssh:a',
  enforceLocalSshWebRtcPolicyForGuest: vi.fn()
}))

import {
  hardenBrowserPageGuestPreferences,
  isAdmissibleBrowserPageGuest
} from './browser-page-guest-admission'

describe('isAdmissibleBrowserPageGuest', () => {
  it('admits profile and local-SSH partitions on any navigable URL', () => {
    expect(isAdmissibleBrowserPageGuest('persist:orca-browser', 'https://example.com')).toBe(true)
    expect(isAdmissibleBrowserPageGuest('orca-local-ssh:a', 'http://localhost:3000')).toBe(true)
  })

  it('admits route partitions only while blank', () => {
    expect(isAdmissibleBrowserPageGuest('orca-route:a', 'about:blank')).toBe(true)
    expect(isAdmissibleBrowserPageGuest('orca-route:a', 'https://example.com')).toBe(false)
  })

  it('refuses unknown partitions and unnavigable URLs', () => {
    expect(isAdmissibleBrowserPageGuest('persist:attacker', 'https://example.com')).toBe(false)
    expect(isAdmissibleBrowserPageGuest('persist:orca-browser', 'javascript:alert(1)')).toBe(false)
  })
})

describe('hardenBrowserPageGuestPreferences', () => {
  it('overwrites every privilege the renderer could have asked for', () => {
    const prefs: WebPreferences & Record<string, unknown> = {
      preload: '/evil.js',
      preloadURL: 'file:///evil.js',
      additionalArguments: ['--evil'],
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      enableBlinkFeatures: 'Evil',
      partition: 'persist:attacker'
    }
    hardenBrowserPageGuestPreferences(prefs, 'persist:orca-browser', '/close-preload.js')

    expect(prefs).toMatchObject({
      preload: '/close-preload.js',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      enableBlinkFeatures: '',
      partition: 'persist:orca-browser'
    })
    expect(prefs).not.toHaveProperty('preloadURL')
    expect(prefs).not.toHaveProperty('additionalArguments')
  })
})
