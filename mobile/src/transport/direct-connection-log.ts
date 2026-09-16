import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type { LivenessTimeoutEvidence } from './rpc-session-liveness-watchdog'
import type {
  ConnectionLogEntry,
  ConnectionLogLevel,
  ConnectionLogSink,
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
    evidence?: Pick<ConnectionLogEntry, 'code' | 'path'>
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

  connected = (): void => {
    this.emit('success', 'Authenticated', 'Channel ready for RPC', { code: 'direct-connected' })
  }
}
