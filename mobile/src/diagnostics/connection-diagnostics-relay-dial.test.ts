import { describe, expect, it } from 'vitest'
import {
  diagnoseConnection,
  getReportableConnectionIncidentId
} from './connection-diagnostics-analysis'
import type { ConnectionLogEntry } from '../transport/types'

// Provenance: the last two resume windows of a real diagnostics export (Orca
// Mobile 0.0.50 against host 1.4.203, 2026-09-18), which read "No single failure
// cause can be determined". Every relay dial ended in 4404 and the LAN dial
// timed out, then the app resumed and the export was cut before the next outcome:
//
//   [info]  [app-resumed]              App returned to foreground
//   [info]  [lan]                      Opening WebSocket — 192.168.1.2:55927
//   [error] [relay-dial-failed relay]  Relay: relay dial failed — Error: relay_outer_4404
//   [error] [connect-timeout lan]      WebSocket connect timeout — No TCP/WS handshake within 12s
//   [warn]  [socket-closed lan]        WebSocket closed — Close code unavailable
//   [info]  [retry-scheduled lan]      Reconnect scheduled in 500ms — Attempt 1

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

const authenticated = () =>
  entry({ level: 'success', code: 'direct-connected', path: 'lan', message: 'Authenticated' })

// One resume window exactly as the export recorded it.
function resumeWindow(closeCode: number): ConnectionLogEntry[] {
  return [
    appResumed(),
    lanOpening(),
    relayDialFailed(closeCode),
    lanConnectTimeout(),
    retryScheduled()
  ]
}

function diagnose(entries: readonly ConnectionLogEntry[]) {
  return diagnoseConnection({
    endpoint: ENDPOINT,
    state: 'connecting',
    activePath: 'lan',
    pendingPath: null,
    entries
  })
}

const HOST_OFFLINE_CAUSE =
  'Relay answered, but the desktop is not connected to it (close code 4404, host offline).'
const HOST_OFFLINE_STEP =
  'Check the desktop is awake, Orca is running, and it is signed in to Orca Cloud.'

describe('diagnoseConnection on the relay-4404 export', () => {
  // The export is cut mid-window, so the newest evidence predates the last resume.
  const CUT_MID_WINDOW = [...resumeWindow(4404), ...resumeWindow(4404), appResumed(), lanOpening()]

  it('names the offline host from the evidence before the last resume', () => {
    expect(diagnose(CUT_MID_WINDOW)).toEqual({
      likelyCause: `Before the app last resumed: ${HOST_OFFLINE_CAUSE}`,
      nextStep: HOST_OFFLINE_STEP,
      reportability: 'none'
    })
  })

  it('drops the stale qualifier once the 4404 lands in the current resume window', () => {
    expect(diagnose([appResumed(), lanOpening(), relayDialFailed(4404)])).toEqual({
      likelyCause: HOST_OFFLINE_CAUSE,
      nextStep: HOST_OFFLINE_STEP,
      reportability: 'none'
    })
  })

  // The LAN dial times out after the relay dial in every window; that timeout is
  // the phone being off the LAN, and must not outrank the cell's verdict.
  it('prefers the relay verdict over a newer direct timeout in the same window', () => {
    expect(diagnose(resumeWindow(4404)).likelyCause).toBe(HOST_OFFLINE_CAUSE)
  })

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

  it('does not reach past a connection for stale evidence', () => {
    expect(
      diagnose([...resumeWindow(4404), authenticated(), appResumed(), lanOpening()]).likelyCause
    ).toBe('No single failure cause can be determined from the recorded events.')
  })
})

describe('diagnoseConnection on the other relay close codes', () => {
  const window = (closeCode: number) => [appResumed(), lanOpening(), relayDialFailed(closeCode)]

  it('explains a refused relay credential', () => {
    expect(diagnose(window(4401))).toEqual({
      likelyCause: 'Relay refused this device’s relay credential (close code 4401).',
      nextStep: 'Re-pair this phone with the desktop.',
      reportability: 'none'
    })
  })

  it('blames the phone’s connection on a transport close', () => {
    expect(diagnose(window(1006))).toEqual({
      likelyCause: 'The phone could not reach the Relay cell (transport close 1006).',
      nextStep: 'Check this phone’s network connection; Relay recovery retries automatically.',
      reportability: 'none'
    })
  })

  it('reports an unmapped cell code as a retrying dial', () => {
    expect(diagnose(window(4409)).likelyCause).toBe(
      'Relay closed the dial with code 4409; recovery re-resolves and retries.'
    )
  })

  // A dial that never reached the cell carries no close code at all.
  it('falls back to a pre-cell dial failure when the code is missing', () => {
    const noCode = { ...relayDialFailed(4404), relayCloseCode: undefined, detail: undefined }
    expect(diagnose([appResumed(), lanOpening(), noCode])).toEqual({
      likelyCause: 'The Relay dial failed before the cell answered.',
      nextStep: 'Check this phone’s network connection; Relay recovery retries automatically.',
      reportability: 'none'
    })
  })

  it('leaves a director outage to the director branch', () => {
    const director = {
      ...relayDialFailed(4404),
      relayCloseCode: undefined,
      detail: 'RelayDirectorHttpError: relay director resolve failed (503); retry-after=30000ms'
    }
    expect(diagnose([appResumed(), lanOpening(), director]).likelyCause).toBe(
      'Relay service was temporarily unavailable and asked Orca to retry in 30s.'
    )
  })
})

describe('diagnoseConnection ordering among relay failures', () => {
  const relaySessionFailed = () =>
    entry({
      level: 'error',
      code: 'relay-session-failed',
      path: 'relay',
      message: 'Relay: active relay session failed',
      detail: 'Error: relay_outer_4408',
      relayCloseCode: 4408
    })
  const relayConnected = () =>
    entry({
      level: 'success',
      code: 'relay-connected',
      path: 'relay',
      message: 'Relay: runtime channel migrated to relay'
    })
  const directorRefused = () =>
    entry({
      level: 'error',
      code: 'relay-dial-failed',
      path: 'relay',
      message: 'Relay: relay dial failed',
      detail: 'RelayDirectorHttpError: relay director resolve failed (401)'
    })

  // A make-before-break replacement dial fails 4404, then the still-live session
  // drops: the newer close is the incident, and it stays sendable.
  it('never hides a newer relay session close behind an older verdict', () => {
    const entries = [relayConnected(), relayDialFailed(4404), relaySessionFailed()]
    expect(diagnose(entries).likelyCause).toBe('The active Relay session closed unexpectedly.')
    expect(
      getReportableConnectionIncidentId({ endpoint: ENDPOINT, state: 'reconnecting', entries })
    ).toBe(entries[2]?.id)
  })

  it('never hides a newer director refusal behind an older verdict', () => {
    expect(diagnose([appResumed(), relayDialFailed(4404), directorRefused()]).likelyCause).toBe(
      'Relay rejected the saved resume credential.'
    )
  })

  it('names a network change, not a resume, when that is the boundary', () => {
    const networkChanged = () =>
      entry({ level: 'info', code: 'network-changed', message: 'Network changed' })
    expect(diagnose([relayDialFailed(4404), networkChanged(), lanOpening()]).likelyCause).toBe(
      `Before the last network change: ${HOST_OFFLINE_CAUSE}`
    )
  })
})
