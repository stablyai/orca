import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  MOBILE_WEB_SHELL_FEATURES,
  parseMobileWebBridgeInitialMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

// The native package store mints session ids as base64url of 32 random bytes. The page parses the
// shell's own init with the shared contract, and a session id the contract rejects takes the whole
// bridge down silently: no client, no ready, no health, a workspace list that spins forever.
const NATIVE_SESSION_ID = 'Rk9-x1Qm_TbY4ZpL0sWc2vNhJgEuA6iD8oK3rXfPq7M'
const NATIVE_BUILD_ID = 'a'.repeat(64)

function hybridInitMessage(shellSessionId: string) {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'init',
    shellSessionId,
    buildId: NATIVE_BUILD_ID,
    connection: 'connected',
    hostDisplayName: 'Orca Desktop',
    reconnectAttempts: 0,
    lastConnectedAt: 1_788_000_000_000,
    resumeRoute: { kind: 'workspaceList' },
    grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
    shellFeatures: [...MOBILE_WEB_SHELL_FEATURES]
  }
}

describe('hosted shell init contract', () => {
  it('parses the init the hybrid screen posts with a native session id', () => {
    const parsed = parseMobileWebBridgeInitialMessage(
      JSON.stringify(hybridInitMessage(NATIVE_SESSION_ID))
    )

    expect(parsed.ok ? 'ok' : parsed.error).toBe('ok')
  })

  // A newer APK advertises features this page has never heard of. They are opaque strings for
  // exactly this reason: a closed set would fail the array, and a failed init costs every grant.
  it('keeps init parseable when the shell advertises an unknown feature', () => {
    const parsed = parseMobileWebBridgeInitialMessage(
      JSON.stringify({
        ...hybridInitMessage(NATIVE_SESSION_ID),
        shellFeatures: [...MOBILE_WEB_SHELL_FEATURES, 'nativeChat.somethingNewer.v1']
      })
    )

    expect(parsed.ok ? 'ok' : parsed.error).toBe('ok')
    expect(parsed.ok && parsed.value.shellFeatures).toContain('nativeChat.somethingNewer.v1')
    expect(parsed.ok && parsed.value.grants.length).toBe(MOBILE_WEB_PRODUCTION_GRANTS.length)
  })

  // A shell built before any feature existed sends no list at all, which must read as "none".
  it('parses an init from a shell that advertises nothing', () => {
    const { shellFeatures: _omitted, ...withoutFeatures } = hybridInitMessage(NATIVE_SESSION_ID)
    const parsed = parseMobileWebBridgeInitialMessage(JSON.stringify(withoutFeatures))

    expect(parsed.ok ? 'ok' : parsed.error).toBe('ok')
    expect(parsed.ok && parsed.value.shellFeatures).toBeUndefined()
  })

  it('pins the session id shape the native stores must mint', () => {
    expect(NATIVE_SESSION_ID).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const rejected = parseMobileWebBridgeInitialMessage(
      JSON.stringify(hybridInitMessage('nvlk2e54kb4ttic4z2sqahkm6mvxnxfzrsp6gxw74fif7ajyt5oq'))
    )

    expect(rejected.ok).toBe(false)
  })
})
