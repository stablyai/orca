import { describe, expect, it } from 'vitest'
import {
  hostedIosLogStartTime,
  hostedIosPrivacyLogEvidence
} from '../../scripts/hosted-ios-privacy-log-audit.mjs'

describe('hosted iOS privacy log audit', () => {
  it('formats simulator log start times without ISO separators', () => {
    const value = hostedIosLogStartTime(new Date(2026, 6, 29, 12, 34, 56).getTime())

    expect(value).toBe('2026-07-29 12:34:56')
  })

  it('accepts fixed-category connection and recovery logs', () => {
    expect(
      hostedIosPrivacyLogEvidence(
        '[net] state {"endpoint":"websocket","from":"connecting","to":"connected"}'
      )
    ).toEqual({
      logBytes: 73,
      counts: {
        privilegedField: 0,
        tokenStorage: 0,
        nativeAuthority: 0,
        privateOriginUrl: 0,
        webSocketUrl: 0,
        fixtureMarker: 0
      }
    })
  })

  it.each([
    'deviceToken',
    'orca.host-token.host-a',
    'openHostLogicalClient',
    'orca-mobile-web://abcdefghijklmnopqrstuvwxyz/',
    'wss://paired-host.invalid/socket',
    'ORCA_E2E_MOBILE_WEB_HOST_PUBLIC_KEY'
  ])('rejects privileged log marker %s', (marker) => {
    expect(() => hostedIosPrivacyLogEvidence(marker)).toThrow('privacy log audit failed')
  })
})
