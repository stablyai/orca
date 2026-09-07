import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
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
  const failure = findCurrentDiagnosticFailure(args.entries)
  const evidence = failure ? `${failure.code ?? ''} ${failure.message} ${failure.detail ?? ''}` : ''

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
  if (diagnoseConnection(args).reportability !== 'orca-relay') {
    return null
  }
  return findCurrentDiagnosticFailure(args.entries)?.id ?? null
}

function findCurrentDiagnosticFailure(
  entries: readonly ConnectionLogEntry[]
): ConnectionLogEntry | undefined {
  const boundaryIndex = entries.findLastIndex(isDiagnosticBoundary)
  return entries
    .slice(boundaryIndex + 1)
    .toReversed()
    .find(isDiagnosticFailure)
}

function isDiagnosticBoundary(entry: ConnectionLogEntry): boolean {
  return (
    entry.code === 'client-session-started' ||
    entry.code === 'app-resumed' ||
    entry.code === 'network-changed' ||
    entry.code === 'relay-connected' ||
    entry.code === 'direct-connected' ||
    entry.message === 'Authenticated'
  )
}

function isDiagnosticFailure(entry: ConnectionLogEntry): boolean {
  const evidence = `${entry.code ?? ''} ${entry.message} ${entry.detail ?? ''}`
  return /relay director resolve failed \((?:401|503)\)|liveness-timeout|liveness timeout|connection health check failed|relay-session-failed|active relay session failed|authentication-rejected|unauthorized|pairing may be revoked|connect-timeout|websocket connect timeout|handshake-timeout|handshake timeout/i.test(
    evidence
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
