import { describe, expect, it } from 'vitest'
import {
  diagnoseConnection,
  getReportableConnectionIncidentId
} from './connection-diagnostics-analysis'
import type { ConnectionLogEntry } from '../transport/types'

function event(message: string, detail?: string): ConnectionLogEntry {
  return { id: message, ts: 1, level: 'error', message, detail }
}

describe('diagnoseConnection', () => {
  it('reports the current healthy path instead of a historical failure', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'connected',
        activePath: 'relay',
        entries: [event('WebSocket connect timeout')]
      })
    ).toEqual({
      likelyCause: 'Connection is healthy via Relay.',
      nextStep: 'No action needed.',
      reportability: 'none'
    })
  })

  it('distinguishes an invalid Relay credential from a transient outage', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        pendingPath: 'relay',
        entries: [event('Relay: relay dial failed', 'relay director resolve failed (401)')]
      })
    ).toEqual({
      likelyCause: 'Relay rejected the saved resume credential.',
      nextStep: 'Try a direct connection; if Relay keeps returning 401, pair this device again.',
      reportability: 'none'
    })
  })

  it('identifies the direct Tailscale timeout while Relay recovery is pending', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        activePath: 'tailscale',
        pendingPath: 'relay',
        entries: [event('WebSocket connect timeout')]
      })
    ).toEqual({
      likelyCause: 'The saved Tailscale endpoint did not answer before the connection timeout.',
      nextStep: 'Relay recovery is in progress; keep Orca open while it retries.',
      reportability: 'none'
    })
  })

  it('identifies an authenticated Relay liveness failure', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        activePath: 'relay',
        entries: [
          {
            ...event('Relay health check failed'),
            code: 'liveness-timeout',
            path: 'relay'
          }
        ]
      })
    ).toEqual({
      likelyCause: 'Relay stopped answering authenticated health checks.',
      nextStep: 'Orca closed the stale session and started recovery.',
      reportability: 'orca-relay'
    })
  })

  it('separates an active Relay close from a failed Relay dial', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        activePath: 'relay',
        entries: [
          {
            ...event('Relay: active relay session failed', 'RelayOuterError: close code 4408'),
            code: 'relay-session-failed',
            path: 'relay'
          }
        ]
      })
    ).toEqual({
      likelyCause: 'The active Relay session closed unexpectedly.',
      nextStep: 'Orca started Relay recovery; the event history includes the cell close reason.',
      reportability: 'orca-relay'
    })
  })

  it('marks authenticated Relay liveness failures as safe to send', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        activePath: 'relay',
        entries: [
          {
            ...event('Relay health check failed'),
            code: 'liveness-timeout',
            path: 'relay'
          }
        ]
      }).reportability
    ).toBe('orca-relay')
  })

  it.each([
    ['direct timeout', 'connect-timeout', 'tailscale'],
    ['handshake timeout', 'handshake-timeout', 'relay'],
    ['invalid credential', 'relay director resolve failed (401)', 'relay'],
    ['ambiguous recovery', 'retry scheduled', 'relay']
  ] as const)('does not offer submission for %s', (_name, message, path) => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        pendingPath: 'relay',
        entries: [{ ...event(message), path }]
      }).reportability
    ).toBe('none')
  })

  it('does not offer submission for a bounded Relay director outage', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        pendingPath: 'relay',
        entries: [event('Relay: relay dial failed', 'relay director resolve failed (503)')]
      }).reportability
    ).toBe('none')
  })

  it('classifies the newest failure instead of an older persisted 401', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        pendingPath: 'relay',
        entries: [
          event('Relay: relay dial failed', 'relay director resolve failed (401)'),
          { ...event('WebSocket connect timeout'), id: 'newer', ts: 2, code: 'connect-timeout' }
        ]
      }).likelyCause
    ).toBe('The saved Tailscale endpoint did not answer before the connection timeout.')
  })

  it('requires structured Relay evidence before offering submission', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        activePath: 'relay',
        entries: [event('active relay session failed')]
      }).reportability
    ).toBe('none')
  })

  it('ignores failures from before the current app resume boundary', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'connecting',
        activePath: 'lan',
        entries: [
          {
            ...event('Relay health check failed'),
            code: 'liveness-timeout',
            path: 'relay'
          },
          {
            ...event('App returned to foreground'),
            id: 'resume',
            ts: 2,
            code: 'app-resumed'
          },
          { ...event('WebSocket closed'), id: 'closed', ts: 3, code: 'socket-closed' }
        ]
      }).reportability
    ).toBe('none')
  })

  it('uses a structured direct liveness path ahead of the current active path', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        activePath: 'relay',
        entries: [
          {
            ...event('Connection health check failed'),
            code: 'liveness-timeout',
            path: 'lan'
          }
        ]
      })
    ).toEqual({
      likelyCause: 'The connected host stopped answering authenticated health checks.',
      nextStep: 'Orca closed the stale session and started recovery.',
      reportability: 'none'
    })
  })

  it('keys reportability to the current structured incident', () => {
    const args = {
      endpoint: 'ws://192.168.1.2:6768',
      state: 'reconnecting' as const,
      activePath: 'relay' as const,
      entries: [
        { ...event('Authenticated'), code: 'direct-connected' as const, path: 'lan' as const },
        {
          ...event('Relay health check failed'),
          id: 'current-relay-failure',
          ts: 2,
          code: 'liveness-timeout' as const,
          path: 'relay' as const
        }
      ]
    }

    expect(getReportableConnectionIncidentId(args)).toBe('current-relay-failure')
    expect(
      getReportableConnectionIncidentId({
        ...args,
        entries: [...args.entries, { ...event('Network changed'), ts: 3, code: 'network-changed' }]
      })
    ).toBeNull()
  })
})
