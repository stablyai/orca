import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type { LivenessTimeoutEvidence } from './rpc-session-liveness-watchdog'
import type {
  ConnectionLogEntry,
  ConnectionLogLevel,
  ConnectionLogSink,
  ConnectionState,
  MobileConnectionDiagnosticPath
} from './types'

export class DirectConnectionLog {
  private sequence = 0
  private readonly path: MobileConnectionDiagnosticPath

  constructor(
    endpoint: string,
    private readonly sink?: ConnectionLogSink
  ) {
    this.path = isTailscaleEndpoint(endpoint) ? 'tailscale' : 'lan'
  }

  emit = (
    level: ConnectionLogLevel,
    message: string,
    detail?: string,
    evidence?: Pick<ConnectionLogEntry, 'code' | 'path' | 'timing'>
  ): void => {
    this.sink?.({
      id: `log-${++this.sequence}-${Date.now()}`,
      ts: Date.now(),
      level,
      message,
      detail,
      ...evidence,
      path: evidence?.path ?? this.path
    })
  }

  livenessTimeout = (evidence: LivenessTimeoutEvidence): void => {
    this.emit(
      'error',
      'Connection health check failed',
      `${evidence.reason}; ${evidence.missedProbes}/${evidence.missedProbeLimit} probes missed; last authenticated activity ${evidence.lastInboundAgeMs}ms ago`,
      { code: 'liveness-timeout' }
    )
  }

  // Why: how long the client sat in each ConnectionState used to go only to
  // console, so a shared diagnostics report could not show where a slow connect
  // spent its seconds.
  stateDwell = (previous: ConnectionState, next: ConnectionState, dweltMs: number): void => {
    this.emit('info', `Connection state ${previous} → ${next}`, `${dweltMs}ms in ${previous}`, {
      timing: { kind: 'connection-state', name: previous, ms: dweltMs, complete: true }
    })
  }

  retryScheduled = (message: string, detail?: string): void => {
    this.emit('info', message, detail, { code: 'retry-scheduled' })
  }

  authenticationRejected = (message: string, detail?: string): void => {
    this.emit('warn', message, detail, { code: 'authentication-rejected' })
  }

  connected = (): void => {
    this.emit('success', 'Authenticated', 'Channel ready for RPC', { code: 'direct-connected' })
  }
}
