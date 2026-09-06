import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  hostedAndroidExitInfoEvidence,
  hostedAndroidPrivacyLogEvidence
} from '../../scripts/hosted-android-privacy-audit.mjs'

const priorExit = exitInfo(0, 100, 10, 'USER REQUESTED')
const routeHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-android-source-control-review-e2e.mjs', import.meta.url),
  'utf8'
)

describe('hosted Android privacy audit', () => {
  it('keeps DOM, log, and process-exit audits in the live route gate', () => {
    expect(routeHarnessSource).toContain('verifyHostedWebViewPrivacyIsolation')
    expect(routeHarnessSource).toContain('readHostedAndroidExitInfo')
    expect(routeHarnessSource).toContain('verifyHostedAndroidPrivacyAudit')
  })

  it('accepts fixed-category logs', () => {
    expect(hostedAndroidPrivacyLogEvidence('I/Orca: state=connected retries=1')).toMatchObject({
      logBytes: 33,
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
    expect(() => hostedAndroidPrivacyLogEvidence(marker)).toThrow(
      'Hosted Android privacy log audit failed'
    )
  })

  it('allows only exact debug-server and deliberate probe WebSockets', () => {
    const evidence = hostedAndroidPrivacyLogEvidence(
      [
        'ws://10.0.2.2:8081/message?device=Pixel%209%20-%2016%20-%20API%2036&app=com.stably.orca.mobile&clientid=BridgelessDevSupportManager',
        'ws://10.0.2.2:8081/message?device=Pixel%209%20-%2016%20-%20API%2036&app=com.stably.orca.mobile&clientid=DevLauncherBridgelessDevSupportManager',
        'ws://10.0.2.2:57999/message?device=Pixel%209&app=com.stably.orca.mobile&clientid=BridgelessDevSupportManager',
        'ws://127.0.0.1:53250/socket-probe'
      ].join('\n'),
      { devServerPort: 57999, probePort: 53250 }
    )

    expect(evidence.expectedDebugWebSocketUrls).toBe(4)
    expect(evidence.counts.webSocketUrl).toBe(0)
  })

  it.each([
    'ws://10.0.2.2:8081/message?device=Pixel&app=com.stably.orca.mobile&clientid=BridgelessDevSupportManager&token=secret',
    'ws://10.0.2.2:8081/message?device=Pixel&app=other&clientid=BridgelessDevSupportManager',
    'ws://10.0.2.2:8082/message?device=Pixel&app=com.stably.orca.mobile&clientid=BridgelessDevSupportManager',
    'wss://127.0.0.1:53250/socket-probe',
    'ws://127.0.0.1:53250/socket-probe?token=secret'
  ])('rejects mutated debug WebSocket %s', (url) => {
    expect(() =>
      hostedAndroidPrivacyLogEvidence(url, { devServerPort: 8081, probePort: 53250 })
    ).toThrow('Hosted Android privacy log audit failed')
  })

  it('ignores renumbered baseline exits and accepts a new force-stop', () => {
    const evidence = hostedAndroidExitInfoEvidence(
      priorExit,
      `${exitInfo(0, 200, 10, 'USER REQUESTED')}\n${exitInfo(1, 100, 10, 'USER REQUESTED')}`
    )

    expect(evidence).toMatchObject({
      currentRecords: 2,
      newRecords: 1,
      failureRecords: 0
    })
  })

  it.each([
    [4, 'CRASH'],
    [5, 'NATIVE CRASH'],
    [6, 'ANR'],
    [7, 'INITIALIZATION FAILURE'],
    [9, 'EXCESSIVE RESOURCE USAGE']
  ])('rejects new process failure reason %s', (reason, label) => {
    expect(() =>
      hostedAndroidExitInfoEvidence(priorExit, `${exitInfo(0, 200, reason, label)}\n${priorExit}`)
    ).toThrow('recorded a process failure')
  })

  it('rejects privileged markers in new exit records', () => {
    expect(() =>
      hostedAndroidExitInfoEvidence(
        priorExit,
        `${exitInfo(0, 200, 10, 'USER REQUESTED', 'publicKeyB64')}\n${priorExit}`
      )
    ).toThrow('Hosted Android exit-info privacy log audit failed')
  })
})

function exitInfo(index, timestamp, reason, label, description = 'test') {
  return `ApplicationExitInfo #${index}:
    timestamp=${timestamp} pid=${timestamp}
    process=com.stably.orca.mobile reason=${reason} (${label}) status=0
    importance=100 description=${description} trace=null`
}
