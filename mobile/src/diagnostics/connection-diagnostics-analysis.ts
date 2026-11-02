import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
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
  // Pre-resume/network-change evidence can explain an unanswered host, but cannot be submitted as a current incident.
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

  if (failure?.code === 'suspended-dial') {
    return {
      likelyCause: 'Connection deadline delivery was delayed; the app may have been suspended.',
      nextStep: 'Orca is re-dialing to check the connection. Keep the app open while it retries.',
      reportability: 'none'
    }
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

// Include the relay close code in the longer copy users paste into bug reports.
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

// The relay code names desktop state; a direct timeout may only mean the phone is off LAN. Neither cause is reportable as a relay fault.
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

// Prefer current-window failures, then mark older evidence stale; frequent iOS resumes must not erase the only known cause.
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

// Relay evidence names desktop state and outranks off-LAN direct timeouts; among relay failures, prefer the newest.
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
  if (entry.code === 'native-render-failed') {
    return false
  }
  return /suspended-dial|relay director resolve failed \((?:401|503)\)|liveness-timeout|liveness timeout|connection health check failed|relay-dial-failed|relay dial failed|relay-session-failed|active relay session failed|authentication-rejected|unauthorized|pairing may be revoked|connect-timeout|websocket connect timeout|handshake-timeout|handshake timeout/i.test(
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
  return path === 'tailscale' ? 'Tailscale/direct' : 'LAN/direct'
}
