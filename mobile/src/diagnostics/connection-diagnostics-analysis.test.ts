import { describe, expect, it } from 'vitest'
import {
  diagnoseConnection,
  getReportableConnectionIncidentId
} from './connection-diagnostics-analysis'
import type { ConnectionLogEntry } from '../transport/types'
import {
  classifyConnection,
  isConnectionDialing,
  verdictDisplayLabel
} from '../transport/connection-health'
import { irohStatusDisplayLabel } from '../transport/mobile-iroh-host-status'
import {
  mobileConnectionPathAccessibilityLabel,
  mobileConnectionPathLabel
} from '../transport/mobile-connection-path-label'

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

  it.each(['WebSocket connect timeout', 'Transport connect timeout'])(
    'classifies %s while Relay recovery is pending',
    (message) => {
      expect(
        diagnoseConnection({
          endpoint: 'ws://100.88.90.25:6768',
          state: 'reconnecting',
          activePath: 'tailscale',
          pendingPath: 'relay',
          entries: [event(message)]
        })
      ).toEqual({
        likelyCause: 'The saved Tailscale endpoint did not answer before the connection timeout.',
        nextStep: 'Relay recovery is in progress; keep Orca open while it retries.',
        reportability: 'none'
      })
    }
  )

  it.each(['connect-timeout', 'Transport connect timeout'])(
    'uses an Iroh %s path ahead of the saved endpoint',
    (message) => {
      const args = {
        state: 'reconnecting' as const,
        entries: [{ ...event(message), path: 'iroh' as const }]
      }
      const diagnosis = diagnoseConnection({ ...args, endpoint: 'ws://100.88.90.25:6768' })
      expect(diagnosis).toEqual(
        diagnoseConnection({ ...args, endpoint: 'iroh://desktop-endpoint' })
      )
      expect(diagnosis).toEqual({
        likelyCause:
          'The native Iroh connection did not become ready before the connection timeout.',
        nextStep:
          'Check Iroh direct/relay connectivity on both devices and confirm the desktop is awake with Orca running.',
        reportability: 'none'
      })
    }
  )

  it.each([
    { phase: 'attempting', detail: '', hint: 'Iroh attempting…' },
    {
      phase: 'failed',
      detail: 'native_module_unavailable',
      hint: 'Iroh failed: native_module_unavailable'
    }
  ] as const)('keeps $phase Iroh diagnostics visible while dialing', ({ phase, detail, hint }) => {
    const args = {
      state: 'reconnecting' as const,
      reconnectAttempts: 1,
      lastConnectedAt: null,
      endpoint: 'ws://100.88.90.25:6768',
      pendingPath: 'iroh' as const,
      irohHint: irohStatusDisplayLabel({ phase, detail, updatedAt: 1 })
    }
    const dialing = classifyConnection(args)
    expect(isConnectionDialing(dialing)).toBe(true)
    expect(verdictDisplayLabel(dialing)).toBe(`Reconnecting… — ${hint}`)

    const outage = classifyConnection({ ...args, reconnectAttempts: 3 })
    expect(isConnectionDialing(outage)).toBe(false)
    expect(verdictDisplayLabel(outage)).toBe(`Can't connect — check Tailscale; ${hint}`)
    expect(verdictDisplayLabel(classifyConnection({ ...args, state: 'connected' }))).toBe(
      'Connected'
    )
    expect(mobileConnectionPathLabel('iroh')).toBe('Iroh')
    expect(mobileConnectionPathAccessibilityLabel('iroh')).toBe('Iroh')
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

  it.each(['lan', 'tailscale', 'iroh'] as const)(
    'uses structured %s liveness evidence ahead of the current active path',
    (path) => {
      expect(
        diagnoseConnection({
          endpoint: 'ws://192.168.1.2:6768',
          state: 'reconnecting',
          activePath: 'relay',
          entries: [
            {
              ...event('Connection health check failed'),
              code: 'liveness-timeout',
              path
            }
          ]
        })
      ).toEqual({
        likelyCause: 'The connected host stopped answering authenticated health checks.',
        nextStep: 'Orca closed the stale session and started recovery.',
        reportability: 'none'
      })
    }
  )

  it('does not reuse an earlier endpoint failure after a delayed deadline', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        activePath: 'tailscale',
        entries: [
          { ...event('WebSocket connect timeout'), code: 'connect-timeout', path: 'tailscale' },
          {
            ...event('WebSocket connect interrupted'),
            id: 'delayed',
            ts: 2,
            code: 'suspended-dial',
            path: 'tailscale'
          }
        ]
      })
    ).toEqual({
      likelyCause: 'Connection deadline delivery was delayed; the app may have been suspended.',
      nextStep: 'Orca is re-dialing to check the connection. Keep the app open while it retries.',
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
