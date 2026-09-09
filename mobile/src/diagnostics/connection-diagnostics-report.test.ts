import { describe, expect, it } from 'vitest'
import { buildConnectionDiagnosticsReport } from './connection-diagnostics-report'

const NOW = Date.UTC(2026, 6, 9, 22, 0, 0)

describe('buildConnectionDiagnosticsReport', () => {
  it('summarizes a failing Tailscale host with its log', () => {
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Host 1',
      endpoint: 'ws://100.65.9.106:6768',
      state: 'reconnecting',
      reconnectAttempts: 12,
      lastConnectedAt: NOW - 5 * 60_000,
      platform: 'ios 26.5.1',
      appVersion: '0.0.29',
      desktopAppVersion: '1.4.191',
      entries: [
        {
          id: 'log-1',
          ts: NOW - 60_000,
          level: 'error',
          message: 'WebSocket connect timeout',
          detail: 'No TCP/WS handshake within 12s — endpoint unreachable?'
        }
      ],
      nowMs: NOW
    })

    expect(report).toContain('App: Orca Mobile 0.0.29 · ios 26.5.1')
    expect(report).toContain('Host Orca version: 1.4.191')
    expect(report).toContain('Endpoint: 100.65.9.106:6768 (Tailscale)')
    expect(report).toContain('State: reconnecting (reconnect attempts: 12)')
    expect(report).toContain('(5m 0s ago)')
    expect(report).toContain(
      '[error] WebSocket connect timeout — No TCP/WS handshake within 12s — endpoint unreachable?'
    )
  })

  it('marks never-connected sessions and empty logs', () => {
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Host 2',
      endpoint: 'ws://192.168.1.50:6768',
      state: 'connecting',
      reconnectAttempts: 0,
      lastConnectedAt: null,
      platform: 'android 15',
      appVersion: '0.0.29',
      entries: [],
      nowMs: NOW
    })

    expect(report).toContain('Endpoint: 192.168.1.50:6768')
    expect(report).toContain('Host Orca version: unknown')
    expect(report).not.toContain('(Tailscale)')
    expect(report).toContain('Last connected: never this session')
    expect(report).toContain('No connection events recorded.')
  })

  it('explains the most likely cause and redacts credentials before copying', () => {
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Host 3',
      endpoint: 'ws://100.88.90.25:6768',
      state: 'reconnecting',
      reconnectAttempts: 4,
      lastConnectedAt: null,
      platform: 'android 36',
      appVersion: '0.0.46',
      activePath: 'tailscale',
      pendingPath: 'relay',
      entries: [
        {
          id: 'relay-failure',
          ts: NOW - 5_000,
          level: 'error',
          message: 'Relay: relay dial failed',
          detail:
            'RelayDirectorHttpError: relay director resolve failed (503); retry after 30000ms; resumeToken=secret-resume-token'
        }
      ],
      nowMs: NOW
    })

    expect(report).toContain(
      'Likely cause: Relay service was temporarily unavailable and asked Orca to retry in 30s.'
    )
    expect(report).toContain('Path: active=tailscale; recovery=relay')
    expect(report).toContain('Next step: Keep Orca open; recovery should retry automatically.')
    expect(report).toContain('resumeToken=[redacted]')
    expect(report).not.toContain('secret-resume-token')
  })

  it('redacts quoted JSON credentials and never echoes an invalid endpoint', () => {
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Host 4',
      endpoint: 'not-a-url?token=endpoint-secret',
      state: 'reconnecting',
      reconnectAttempts: 1,
      lastConnectedAt: null,
      platform: 'android 36',
      appVersion: '0.0.47',
      entries: [
        {
          id: 'json-secret',
          ts: NOW,
          level: 'error',
          message: 'Relay failed',
          detail: '{"resumeToken":"json-secret","authorization":"Bearer bearer-secret"}'
        }
      ],
      nowMs: NOW
    })

    expect(report).toContain('Endpoint: invalid endpoint')
    expect(report).not.toContain('endpoint-secret')
    expect(report).not.toContain('json-secret')
    expect(report).not.toContain('bearer-secret')
  })

  it('bounds a single event line before submission while preserving its identity', () => {
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Host 5',
      endpoint: 'ws://192.168.1.2:6768',
      state: 'reconnecting',
      reconnectAttempts: 1,
      lastConnectedAt: null,
      platform: 'android 36',
      appVersion: '0.0.47',
      entries: [
        {
          id: 'oversized',
          ts: NOW,
          level: 'error',
          message: `newest oversized ${'😀'.repeat(2_000)}`
        }
      ],
      nowMs: NOW
    })

    expect(report).toContain('newest oversized')
    expect(report).toContain('[truncated]')
    expect(new TextEncoder().encode(report.split('\n').at(-1)!).byteLength).toBeLessThanOrEqual(
      2048
    )
  })
})
