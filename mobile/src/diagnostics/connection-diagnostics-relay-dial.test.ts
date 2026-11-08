import { describe, expect, it } from 'vitest'
import { getReportableConnectionIncidentId } from './connection-diagnostics-analysis'
import type { ConnectionLogEntry } from './connection/connection-log-types'

// Reproduce a 0.0.50 phone / 1.4.203 host export (2026-09-18): relay dials failed 4404, LAN timed out, and a resume before export erased the reported cause.

const ENDPOINT = 'ws://192.168.1.2:55927'
let sequence = 0

function entry(fields: Omit<ConnectionLogEntry, 'id' | 'ts'>): ConnectionLogEntry {
  sequence += 1
  return { id: `export-${sequence}`, ts: Date.parse('2026-09-18T22:44:00Z') + sequence, ...fields }
}

const appResumed = () =>
  entry({
    level: 'info',
    code: 'app-resumed',
    message: 'App returned to foreground',
    detail: 'Connection recovery notified'
  })

const lanOpening = () =>
  entry({ level: 'info', path: 'lan', message: 'Opening WebSocket', detail: '192.168.1.2:55927' })

const relayDialFailed = (closeCode: number) =>
  entry({
    level: 'error',
    code: 'relay-dial-failed',
    path: 'relay',
    message: 'Relay: relay dial failed',
    detail: `Error: relay_outer_${closeCode}`,
    relayCloseCode: closeCode
  })

const lanConnectTimeout = () =>
  entry({
    level: 'error',
    code: 'connect-timeout',
    path: 'lan',
    message: 'WebSocket connect timeout',
    detail: 'No TCP/WS handshake within 12s — endpoint unreachable?'
  })

const retryScheduled = () =>
  entry({
    level: 'info',
    code: 'retry-scheduled',
    path: 'lan',
    message: 'Reconnect scheduled in 500ms',
    detail: 'Attempt 1'
  })

function resumeWindow(closeCode: number): ConnectionLogEntry[] {
  return [
    appResumed(),
    lanOpening(),
    relayDialFailed(closeCode),
    lanConnectTimeout(),
    retryScheduled()
  ]
}

describe('diagnoseConnection on the relay-4404 export', () => {
  // The export ends before a new outcome, so the latest evidence predates resume.
  const CUT_MID_WINDOW = [...resumeWindow(4404), ...resumeWindow(4404), appResumed(), lanOpening()]

  // The later LAN timeout only means the phone is off LAN; it must not outrank the relay verdict.

  it('is never a sendable relay incident', () => {
    expect(
      getReportableConnectionIncidentId({
        endpoint: ENDPOINT,
        state: 'connecting',
        entries: CUT_MID_WINDOW
      })
    ).toBeNull()
    expect(
      getReportableConnectionIncidentId({
        endpoint: ENDPOINT,
        state: 'connecting',
        entries: resumeWindow(4404)
      })
    ).toBeNull()
  })
})
