import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
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
    grants: [...MOBILE_WEB_PRODUCTION_GRANTS]
  }
}

describe('hosted shell init contract', () => {
  it('accepts the literal version sent by installed version-2 shells', () => {
    expect(hybridInitMessage(NATIVE_SESSION_ID).version).toBe(2)
    const parsed = parseMobileWebBridgeInitialMessage(
      JSON.stringify({ ...hybridInitMessage(NATIVE_SESSION_ID), version: 2 })
    )

    expect(parsed.ok ? parsed.value.version : parsed.error).toBe(2)
  })

  it('parses the init the hybrid screen posts with a native session id', () => {
    const parsed = parseMobileWebBridgeInitialMessage(
      JSON.stringify(hybridInitMessage(NATIVE_SESSION_ID))
    )

    expect(parsed.ok ? 'ok' : parsed.error).toBe('ok')
  })

  it('pins the session id shape the native stores must mint', () => {
    expect(NATIVE_SESSION_ID).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const rejected = parseMobileWebBridgeInitialMessage(
      JSON.stringify(hybridInitMessage('nvlk2e54kb4ttic4z2sqahkm6mvxnxfzrsp6gxw74fif7ajyt5oq'))
    )

    expect(rejected.ok).toBe(false)
  })
})
