import { describe, expect, it } from 'vitest'
import { getReportableConnectionIncidentId } from './connection-diagnostics-analysis'
import type { ConnectionLogEntry } from './connection/connection-log-types'

function event(message: string, detail?: string): ConnectionLogEntry {
  return { id: message, ts: 1, level: 'error', message, detail }
}

describe('diagnoseConnection', () => {
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
