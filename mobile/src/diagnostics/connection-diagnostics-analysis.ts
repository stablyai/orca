import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import {
  relayHostReachabilityForCloseCode,
  type RelayHostReachabilityFromCloseCode
} from '../transport/relay-host-reachability'
import type {
  ConnectionLogEntry,
  ConnectionState,
  MobileConnectionDiagnosticPath
} from '../transport/types'

export type ConnectionDiagnosis = {
  likelyCause: string
  nextStep: string
  reportability: 'none' | 'orca-relay'
}

type DiagnoseConnectionArgs = {
  endpoint: string
  state: ConnectionState
  activePath?: MobileConnectionDiagnosticPath
  pendingPath?: MobileConnectionDiagnosticPath | null
  entries: readonly ConnectionLogEntry[]
}

export function diagnoseConnection(args: DiagnoseConnectionArgs): ConnectionDiagnosis {
  if (args.state === 'connected') {
    return {
      likelyCause: `Connection is healthy${args.activePath ? ` via ${formatPath(args.activePath)}` : ''}.`,
      nextStep: 'No action needed.',
      reportability: 'none'
    }
  }
  const selected = selectDiagnosticFailure(args.entries)
  const failure = selected?.entry
  const evidence = failure ? diagnosticEvidence(failure) : ''
  const diagnosis = diagnoseFailure(args, failure, evidence)
  if (!selected?.staleSince) {
    return diagnosis
  }
  // Evidence from before the last resume or network change is still the best
  // account of a host that has not answered since; it is just not a current,
  // sendable incident.
  const boundary =
    selected.staleSince === 'network-changed' ? 'the last network change' : 'the app last resumed'
  return {
    likelyCause: `Before ${boundary}: ${diagnosis.likelyCause}`,
    nextStep: diagnosis.nextStep,
    reportability: 'none'
  }
}

function diagnoseFailure(
  args: DiagnoseConnectionArgs,
  failure: ConnectionLogEntry | undefined,
  evidence: string
): ConnectionDiagnosis {
  if (/relay director resolve failed \(401\)/i.test(evidence)) {
    return {
      likelyCause: 'Relay rejected the saved resume credential.',
      nextStep: 'Try a direct connection; if Relay keeps returning 401, pair this device again.',
      reportability: 'none'
    }
  }

  if (/relay director resolve failed \(503\)/i.test(evidence)) {
    const retryMs = parseRetryDelayMs(evidence)
    return {
      likelyCause: `Relay service was temporarily unavailable${retryMs == null ? '.' : ` and asked Orca to retry in ${formatDelay(retryMs)}.`}`,
      nextStep: 'Keep Orca open; recovery should retry automatically.',
      reportability: 'none'
    }
  }

  // After the director branches: a director error also arrives as a relay dial failure.
  const relayDial = relayDialFailure(failure)
  if (relayDial) {
    return relayDial
  }

  if (/liveness-timeout|liveness timeout|connection health check failed/i.test(evidence)) {
    const relayLiveness = failure?.code === 'liveness-timeout' && failure.path === 'relay'
    const structuredDirectLiveness =
      failure?.code === 'liveness-timeout' &&
      (failure.path === 'lan' || failure.path === 'tailscale')
    const path =
      relayLiveness || (!structuredDirectLiveness && args.activePath === 'relay')
        ? 'Relay'
        : 'The connected host'
    return {
      likelyCause: `${path} stopped answering authenticated health checks.`,
      nextStep: 'Orca closed the stale session and started recovery.',
      reportability: relayLiveness ? 'orca-relay' : 'none'
    }
  }

  if (/relay-session-failed|active relay session failed/i.test(evidence)) {
    return {
      likelyCause: 'The active Relay session closed unexpectedly.',
      nextStep: 'Orca started Relay recovery; the event history includes the cell close reason.',
      reportability:
        failure?.code === 'relay-session-failed' && failure.path === 'relay' ? 'orca-relay' : 'none'
    }
  }

  if (/authentication-rejected|unauthorized|pairing may be revoked/i.test(evidence)) {
    return {
      likelyCause: 'The desktop rejected this device during authentication.',
      nextStep: 'Confirm the device is still paired; pair it again if the rejection repeats.',
      reportability: 'none'
    }
  }

  if (/connect-timeout|websocket connect timeout/i.test(evidence)) {
    return {
      likelyCause: isTailscaleEndpoint(args.endpoint)
        ? 'The saved Tailscale endpoint did not answer before the connection timeout.'
        : 'The saved direct endpoint did not answer before the connection timeout.',
      nextStep:
        args.pendingPath === 'relay'
          ? 'Relay recovery is in progress; keep Orca open while it retries.'
          : 'Check the local/VPN network and confirm the desktop is awake.',
      reportability: 'none'
    }
  }

  if (/handshake-timeout|handshake timeout/i.test(evidence)) {
    return {
      likelyCause: 'The endpoint opened, but the encrypted Orca handshake did not finish.',
      nextStep: 'Confirm the desktop is running a compatible Orca version and retry.',
      reportability: 'none'
    }
  }

  if (args.pendingPath === 'relay') {
    return {
      likelyCause: 'Relay recovery is selected, but no more specific failure is recorded yet.',
      nextStep: 'Keep this page open while the next recovery event is recorded.',
      reportability: 'none'
    }
  }

  return {
    likelyCause: 'No single failure cause can be determined from the recorded events.',
    nextStep: 'Run diagnostics and copy the report again after the next connection attempt.',
    reportability: 'none'
  }
}

export function getReportableConnectionIncidentId(args: DiagnoseConnectionArgs): string | null {
  const selected = selectDiagnosticFailure(args.entries)
  if (!selected || selected.staleSince) {
    return null
  }
  return diagnoseFailure(args, selected.entry, diagnosticEvidence(selected.entry)).reportability ===
    'orca-relay'
    ? selected.entry.id
    : null
}

// Reads to the relay close code behind a failed dial. Longer than the host
// row's copy on purpose: this is the line the user pastes into a bug report.
const RELAY_DIAL_ADVICE: Record<
  RelayHostReachabilityFromCloseCode,
  { likelyCause: (code: number) => string; nextStep: string }
> = {
  'host-offline': {
    likelyCause: (code) =>
      `Relay answered, but the desktop is not connected to it (close code ${code}, host offline).`,
    nextStep: 'Check the desktop is awake, Orca is running, and it is signed in to Orca Cloud.'
  },
  'credential-refused': {
    likelyCause: (code) => `Relay refused this device’s relay credential (close code ${code}).`,
    nextStep: 'Re-pair this phone with the desktop.'
  },
  unreachable: {
    likelyCause: (code) => `The phone could not reach the Relay cell (transport close ${code}).`,
    nextStep: 'Check this phone’s network connection; Relay recovery retries automatically.'
  },
  connecting: {
    likelyCause: (code) =>
      `Relay closed the dial with code ${code}; recovery re-resolves and retries.`,
    nextStep: 'Keep Orca open while Relay recovery retries.'
  }
}

// The cell's close code names the desktop's state; a direct timeout in the same
// window only says the phone is off the LAN, so the relay verdict wins. Never
// reportable: every cause here is the desktop's or the phone's, not Relay's.
function relayDialFailure(failure: ConnectionLogEntry | undefined): ConnectionDiagnosis | null {
  if (failure?.code !== 'relay-dial-failed') {
    return null
  }
  const code = failure.relayCloseCode
  if (code == null) {
    return {
      likelyCause: 'The Relay dial failed before the cell answered.',
      nextStep: RELAY_DIAL_ADVICE.unreachable.nextStep,
      reportability: 'none'
    }
  }
  const advice = RELAY_DIAL_ADVICE[relayHostReachabilityForCloseCode(code)]
  return { likelyCause: advice.likelyCause(code), nextStep: advice.nextStep, reportability: 'none' }
}

// Newest failure since the last resume/network change; failing that, the newest
// since the last connection or session start, flagged stale. The window used to
// stop at every resume, and iOS resumes the app often enough that a host that
// never answers left the window empty and the report cause-less.
function selectDiagnosticFailure(
  entries: readonly ConnectionLogEntry[]
): { entry: ConnectionLogEntry; staleSince: ResumeBoundary | null } | undefined {
  const sessionStart = entries.findLastIndex(isSessionBoundary) + 1
  const sinceSession = entries.slice(sessionStart)
  const boundaryIndex = sinceSession.findLastIndex(isResumeBoundary)
  const current = newestFailure(sinceSession.slice(boundaryIndex + 1))
  if (current) {
    return { entry: current, staleSince: null }
  }
  const stale = newestFailure(sinceSession.slice(0, boundaryIndex + 1))
  const boundary = sinceSession[boundaryIndex]?.code
  return stale && isResumeBoundaryCode(boundary)
    ? { entry: stale, staleSince: boundary }
    : undefined
}

// Relay-path evidence outranks a newer direct failure: off the LAN every direct
// dial times out, which says nothing, while the relay names the desktop's state.
// Among relay failures the newest wins, so a fresh session close or director
// error is never hidden behind an older verdict.
function newestFailure(entries: readonly ConnectionLogEntry[]): ConnectionLogEntry | undefined {
  const newestFirst = entries.toReversed().filter(isDiagnosticFailure)
  return newestFirst.find((entry) => entry.path === 'relay') ?? newestFirst[0]
}

function isSessionBoundary(entry: ConnectionLogEntry): boolean {
  return (
    entry.code === 'client-session-started' ||
    entry.code === 'relay-connected' ||
    entry.code === 'direct-connected' ||
    entry.message === 'Authenticated'
  )
}

type ResumeBoundary = 'app-resumed' | 'network-changed'

function isResumeBoundaryCode(code: ConnectionLogEntry['code']): code is ResumeBoundary {
  return code === 'app-resumed' || code === 'network-changed'
}

function isResumeBoundary(entry: ConnectionLogEntry): boolean {
  return isResumeBoundaryCode(entry.code)
}

function diagnosticEvidence(entry: ConnectionLogEntry): string {
  return `${entry.code ?? ''} ${entry.message} ${entry.detail ?? ''}`
}

function isDiagnosticFailure(entry: ConnectionLogEntry): boolean {
  return /relay director resolve failed \((?:401|503)\)|liveness-timeout|liveness timeout|connection health check failed|relay-dial-failed|relay dial failed|relay-session-failed|active relay session failed|authentication-rejected|unauthorized|pairing may be revoked|connect-timeout|websocket connect timeout|handshake-timeout|handshake timeout/i.test(
    diagnosticEvidence(entry)
  )
}

function parseRetryDelayMs(evidence: string): number | null {
  const match = /retry(?:-|\s)?after(?:=|\s)(\d+)ms/i.exec(evidence)
  return match ? Number(match[1]) : null
}

function formatDelay(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`
}

function formatPath(path: MobileConnectionDiagnosticPath): string {
  if (path === 'relay') {
    return 'Relay'
  }
  if (path === 'iroh') {
    return 'Iroh'
  }
  return path === 'tailscale' ? 'Tailscale/direct' : 'LAN/direct'
}
