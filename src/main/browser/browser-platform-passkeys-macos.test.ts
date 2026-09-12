import { describe, expect, it, vi } from 'vitest'
import {
  enablePlatformPasskeys,
  readWebAuthnKeychainAccessGroup
} from './browser-platform-passkeys-macos'

const SIGNED_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>TEAM123456.com.stablyai.orca</string>
<key>keychain-access-groups</key>
<array>
  <string>TEAM123456.com.stablyai.orca</string>
  <string>TEAM123456.com.stablyai.orca.webauthn</string>
</array>
<key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>`

type ConfigureWebAuthn = (options: {
  touchID: { keychainAccessGroup: string; promptReason?: string }
}) => void

function packagedApp(): {
  isPackaged: boolean
  configureWebAuthn: ReturnType<typeof vi.fn<ConfigureWebAuthn>>
} {
  return { isPackaged: true, configureWebAuthn: vi.fn<ConfigureWebAuthn>() }
}

describe('readWebAuthnKeychainAccessGroup', () => {
  it('returns the group ending in .webauthn from a signed entitlement plist', () => {
    expect(readWebAuthnKeychainAccessGroup(SIGNED_ENTITLEMENTS)).toBe(
      'TEAM123456.com.stablyai.orca.webauthn'
    )
  })

  it('returns null when the array holds no webauthn group', () => {
    const xml = SIGNED_ENTITLEMENTS.replace(
      '<string>TEAM123456.com.stablyai.orca.webauthn</string>',
      ''
    )
    expect(readWebAuthnKeychainAccessGroup(xml)).toBeNull()
  })

  it('returns null for an unsigned binary whose entitlement dump is empty', () => {
    expect(readWebAuthnKeychainAccessGroup('')).toBeNull()
  })
})

describe('enablePlatformPasskeys', () => {
  it('configures the Touch ID authenticator with the signed group and a prompt reason', () => {
    const app = packagedApp()
    const outcome = enablePlatformPasskeys(app, {
      platform: 'darwin',
      execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
      readEntitlements: () => SIGNED_ENTITLEMENTS
    })
    expect(outcome).toEqual({
      status: 'enabled',
      keychainAccessGroup: 'TEAM123456.com.stablyai.orca.webauthn'
    })
    expect(app.configureWebAuthn).toHaveBeenCalledWith({
      touchID: {
        keychainAccessGroup: 'TEAM123456.com.stablyai.orca.webauthn',
        promptReason: 'sign in to $1'
      }
    })
  })

  it('reads the entitlements of the running executable', () => {
    const readEntitlements = vi.fn(() => SIGNED_ENTITLEMENTS)
    enablePlatformPasskeys(packagedApp(), {
      platform: 'darwin',
      execPath: '/Applications/Orca.app/Contents/MacOS/Orca',
      readEntitlements
    })
    expect(readEntitlements).toHaveBeenCalledWith('/Applications/Orca.app/Contents/MacOS/Orca')
  })

  it.each(['win32', 'linux'] as const)('does nothing on %s', (platform) => {
    const app = packagedApp()
    const readEntitlements = vi.fn(() => SIGNED_ENTITLEMENTS)
    expect(enablePlatformPasskeys(app, { platform, readEntitlements })).toEqual({
      status: 'skipped',
      reason: 'not-macos'
    })
    expect(readEntitlements).not.toHaveBeenCalled()
    expect(app.configureWebAuthn).not.toHaveBeenCalled()
  })

  it('skips unpackaged runs without inspecting the shared Electron binary', () => {
    const app = { ...packagedApp(), isPackaged: false }
    const readEntitlements = vi.fn(() => SIGNED_ENTITLEMENTS)
    expect(enablePlatformPasskeys(app, { platform: 'darwin', readEntitlements })).toEqual({
      status: 'skipped',
      reason: 'unpackaged'
    })
    expect(readEntitlements).not.toHaveBeenCalled()
    expect(app.configureWebAuthn).not.toHaveBeenCalled()
  })

  // Why: a build signed without the group would make Chromium log an entitlement
  // error on every request; leaving the authenticator unconfigured keeps today's behavior.
  it('skips a signed build that lacks the webauthn keychain group', () => {
    const app = packagedApp()
    expect(
      enablePlatformPasskeys(app, {
        platform: 'darwin',
        readEntitlements: () => '<plist version="1.0"><dict></dict></plist>'
      })
    ).toEqual({ status: 'skipped', reason: 'no-entitlement' })
    expect(app.configureWebAuthn).not.toHaveBeenCalled()
  })

  it('skips when the running Electron has no configureWebAuthn', () => {
    const app = { isPackaged: true }
    expect(
      enablePlatformPasskeys(app, {
        platform: 'darwin',
        readEntitlements: () => SIGNED_ENTITLEMENTS
      })
    ).toEqual({ status: 'skipped', reason: 'api-unavailable' })
  })

  it('reports a codesign read failure without throwing', () => {
    const app = packagedApp()
    expect(
      enablePlatformPasskeys(app, {
        platform: 'darwin',
        readEntitlements: () => {
          throw new Error('codesign exited 1')
        }
      })
    ).toEqual({ status: 'failed', error: 'codesign exited 1' })
    expect(app.configureWebAuthn).not.toHaveBeenCalled()
  })

  it('reports a configureWebAuthn failure without throwing', () => {
    const app = packagedApp()
    app.configureWebAuthn.mockImplementation(() => {
      throw new TypeError('bad options')
    })
    expect(
      enablePlatformPasskeys(app, {
        platform: 'darwin',
        readEntitlements: () => SIGNED_ENTITLEMENTS
      })
    ).toEqual({ status: 'failed', error: 'bad options' })
  })
})

describe('startup wiring', () => {
  // Why: configureWebAuthn is process-wide and must land before the first guest can
  // issue a passkey request, so it sits ahead of browser session initialization.
  it('enables platform passkeys before browser sessions initialize', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(
      join(import.meta.dirname, '../startup/main-process-ready-foundation.ts'),
      'utf8'
    )
    const enableIndex = source.indexOf('enablePlatformPasskeys(app)')
    const sessionsIndex = source.indexOf('initializeBrowserSessionsForApp({')
    expect(enableIndex).toBeGreaterThan(-1)
    expect(sessionsIndex).toBeGreaterThan(enableIndex)
  })
})
