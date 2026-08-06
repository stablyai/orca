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
    expect(report).not.toContain('(Tailscale)')
    expect(report).toContain('Last connected: never this session')
    expect(report).toContain('No connection events recorded this session.')
  })
})
