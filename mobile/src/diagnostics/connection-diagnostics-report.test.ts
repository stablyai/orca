import { describe, expect, it } from 'vitest'
import { buildConnectionDiagnosticsReport } from './connection-diagnostics-report'
import type { ConnectionLogEntry } from '../transport/types'

const NOW = Date.UTC(2026, 6, 9, 22, 0, 0)

function stageEntry(
  id: string,
  ts: number,
  name: string,
  ms: number,
  complete: boolean
): ConnectionLogEntry {
  return {
    id,
    ts,
    level: complete ? 'info' : 'warn',
    path: 'relay',
    message: `Relay dial stage ${name} ${complete ? 'finished' : 'did not finish'}`,
    timing: { kind: 'relay-dial-stage', name, ms, complete }
  }
}

function stateEntry(id: string, ts: number, name: string, ms: number): ConnectionLogEntry {
  return {
    id,
    ts,
    level: 'info',
    message: `Connection state ${name} → connected`,
    timing: { kind: 'connection-state', name, ms, complete: true }
  }
}

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
          id: 'relay-stage-opening',
          ts: NOW - 6_000,
          level: 'info',
          path: 'relay',
          message: 'Relay dial stage opening finished',
          detail: '118ms — resumeToken=secret-resume-token',
          timing: { kind: 'relay-dial-stage', name: 'opening', ms: 118, complete: true }
        },
        {
          id: 'relay-failure',
          ts: NOW - 5_000,
          level: 'error',
          message: 'Relay: relay dial failed',
          detail:
            'RelayDirectorHttpError: relay director resolve failed (503); retry after 30000ms; resumeToken=secret-resume-token',
          timing: {
            kind: 'relay-dial-stage',
            name: 'awaiting-hello',
            ms: 9_100,
            complete: false
          }
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
    expect(report).toContain(
      'Relay dial stages: opening 118ms · awaiting-hello 9.1s (did not finish) — total 9.2s'
    )
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

  it('breaks a slow connect down by dial stage and connection state', () => {
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Host 6',
      endpoint: 'ws://192.168.1.50:6768',
      state: 'connected',
      reconnectAttempts: 2,
      lastConnectedAt: NOW,
      platform: 'ios 26.5.1',
      appVersion: '0.0.47',
      entries: [
        stageEntry('a1', NOW - 30_000, 'opening', 90, false),
        stateEntry('s1', NOW - 29_000, 'connecting', 12_000),
        stageEntry('b1', NOW - 20_000, 'opening', 120, true),
        stageEntry('b2', NOW - 19_000, 'awaiting-hello', 6_400, true),
        stageEntry('b3', NOW - 13_000, 'handshaking', 240, true),
        stageEntry('b4', NOW - 12_000, 'confirming', 1_180, true),
        stateEntry('s2', NOW - 11_000, 'connecting', 8_000)
      ],
      nowMs: NOW
    })

    // Only the latest dial is broken out, so a reconnect loop cannot average away
    // the attempt the reporter is complaining about.
    expect(report).toContain(
      'Relay dial stages (latest of 2): opening 120ms · awaiting-hello 6.4s · handshaking 240ms · confirming 1.2s — total 7.9s'
    )
    expect(report).toContain('Connection state dwell: connecting 20.0s ×2')
  })

  it('omits the timing lines when nothing recorded a phase duration', () => {
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Host 7',
      endpoint: 'ws://192.168.1.50:6768',
      state: 'connected',
      reconnectAttempts: 0,
      lastConnectedAt: NOW,
      platform: 'ios 26.5.1',
      appVersion: '0.0.47',
      entries: [{ id: 'plain', ts: NOW, level: 'info', message: 'Authenticated' }],
      nowMs: NOW
    })

    expect(report).not.toContain('Relay dial stages')
    expect(report).not.toContain('Connection state dwell')
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
