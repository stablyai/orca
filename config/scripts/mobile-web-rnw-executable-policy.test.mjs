import { describe, expect, it } from 'vitest'
import {
  assertMobileWebRnwExecutablePolicy,
  mobileWebRnwExecutablePolicyFailure
} from './mobile-web-rnw-executable-policy.mjs'

describe('mobile web RNW executable policy', () => {
  it.each([
    'localStorage.setItem("key","value")',
    'window.sessionStorage.getItem("key")',
    'indexedDB.open("orca")',
    'caches.open("orca")',
    'document.cookie="credential=value"',
    'openDatabase("orca","1","Orca",1024)',
    'navigator.storage.getDirectory()'
  ])('rejects page-owned persistence: %s', (source) => {
    expect(mobileWebRnwExecutablePolicyFailure(source)).toBe('page-owned persistence')
    expect(() => assertMobileWebRnwExecutablePolicy(source)).toThrow('page-owned persistence')
  })

  it.each([
    'const sourcePath="/Users/developer/orca/mobile/app.tsx"',
    'const sourcePath="/home/runner/work/orca/mobile/app.tsx"',
    String.raw`const sourcePath="C:\\Users\\builder\\orca\\mobile\\app.tsx"`
  ])('rejects build environment paths: %s', (source) => {
    expect(mobileWebRnwExecutablePolicyFailure(source)).toBe('build environment path disclosure')
  })

  it.each([
    ['Sentry.captureException(error)', 'hosted telemetry integration'],
    ['fetch("https://api.posthog.com/capture")', 'hosted telemetry integration'],
    ['process.env.ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN', 'test fixture marker'],
    ['process.env.EXPO_PUBLIC_ORCA_E2E_MOBILE_WEB_HOST_PUBLIC_KEY', 'test fixture marker'],
    ['const key = "orca:web-host-token:" + hostId', 'native credential authority'],
    ['const key = "orca.host-token." + hostId', 'native credential authority'],
    ['scheduleHostCredentialCleanup(hostId)', 'native credential authority'],
    ['openHostLogicalClient(host)', 'native credential authority'],
    ['resolvePairingHostIdentity(publicKey, hostId)', 'native credential authority'],
    ['deleteMobileRelayCredentialBundle(hostId)', 'native credential authority']
  ])('rejects production privacy marker %s', (source, expected) => {
    expect(mobileWebRnwExecutablePolicyFailure(source)).toBe(expected)
  })

  it('allows inert syntax-highlighter keyword strings', () => {
    expect(
      mobileWebRnwExecutablePolicyFailure('["document","localStorage","sessionStorage","module"]')
    ).toBeNull()
  })
})
