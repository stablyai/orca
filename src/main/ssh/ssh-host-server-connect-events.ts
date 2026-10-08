/**
 * What one connect's server decision did, in raw codes; ssh-host-server-telemetry maps these onto
 * enum-only events. Nothing here carries a message, path or host name.
 */
import type {
  OrcadManagedConversionResult,
  OrcadManagedDeployResult
} from '../../shared/orcad-managed-runtime'
import type { SshTarget } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'
import { classifyOrcadHostUnavailable } from './orcad-host-unavailable'

export type HostServerConnectEvent =
  | {
      kind: 'decided'
      outcome: 'managed' | 'deployed' | 'converted' | 'relay'
      reason: string
      refusal: string | null
      recorded: boolean
      durationMs: number
    }
  | { kind: 'conversion'; phase: 'started' }
  | { kind: 'conversion'; phase: 'committed'; durationMs: number }
  | {
      kind: 'conversion'
      phase: 'failed'
      failure: 'deferred' | 'refused' | 'error'
      code: string | null
      durationMs: number
    }
  | {
      kind: 'deploy_failed'
      context: 'deploy' | 'conversion'
      failure: 'deferred' | 'error'
      code: string | null
      durationMs: number
    }

/** What a managed host's update on connect did; `connected` when there was nothing to do. */
export type HostServerUpdateReason =
  | 'connected'
  | 'updated'
  | 'update_deferred'
  | 'update_failed'
  | 'update_host_newer'
  | 'update_rolled_back'
  | 'update_check_failed'

/** How far one decision got, filled in as it runs. */
export type HostServerDecisionTrace = {
  startedAt: number
  path: 'existing' | 'deploy' | 'convert' | null
  update: HostServerUpdateReason | null
  conversionStartedAt: number | null
  recorded: boolean
  refusal: string | null
}

export function startHostServerDecisionTrace(now = Date.now()): HostServerDecisionTrace {
  return {
    startedAt: now,
    path: null,
    update: null,
    conversionStartedAt: null,
    recorded: false,
    refusal: null
  }
}

export function decidedEvent(
  result: HostServerOnConnectResult | null,
  trace: HostServerDecisionTrace,
  now = Date.now()
): HostServerConnectEvent {
  const base = { refusal: null, recorded: trace.recorded, durationMs: now - trace.startedAt }
  if (!result) {
    return { kind: 'decided', outcome: 'relay', reason: 'failed', ...base }
  }
  if (result.route === 'managed') {
    if (trace.path === 'deploy') {
      return { kind: 'decided', outcome: 'deployed', reason: 'deployed', ...base }
    }
    if (trace.path === 'convert') {
      return { kind: 'decided', outcome: 'converted', reason: 'converted', ...base }
    }
    return { kind: 'decided', outcome: 'managed', reason: trace.update ?? 'connected', ...base }
  }
  if (result.reason === 'orcad_unavailable') {
    // Why the detail: for this reason it is always a classified code, never a message.
    return { kind: 'decided', outcome: 'relay', reason: result.detail ?? 'other', ...base }
  }
  return {
    kind: 'decided',
    outcome: 'relay',
    reason: result.reason,
    ...base,
    refusal: result.reason === 'refused' ? trace.refusal : null
  }
}

/** A classified code for a thrown setup failure; null when it carries none. */
export function hostServerFailureCode(error: unknown): string | null {
  const unavailable = classifyOrcadHostUnavailable(error)
  if (unavailable) {
    return unavailable
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return null
}

export type HostServerReport = (target: SshTarget, event: HostServerConnectEvent) => void

export function reportHostServerEvent(
  report: HostServerReport,
  target: SshTarget,
  event: HostServerConnectEvent
): void {
  try {
    report(target, event)
  } catch {
    // Telemetry never costs a connect.
  }
}

function sinceMs(startedAt: number | null): number {
  return startedAt === null ? 0 : Date.now() - startedAt
}

export function reportHostServerSetupError(
  report: HostServerReport,
  target: SshTarget,
  trace: HostServerDecisionTrace,
  error: unknown
): void {
  const code = hostServerFailureCode(error)
  if (trace.path === 'deploy') {
    reportHostServerEvent(report, target, {
      kind: 'deploy_failed',
      context: 'deploy',
      failure: 'error',
      code,
      durationMs: sinceMs(trace.startedAt)
    })
  } else if (trace.path === 'convert') {
    reportHostServerEvent(report, target, {
      kind: 'conversion',
      phase: 'failed',
      failure: 'error',
      code,
      durationMs: sinceMs(trace.conversionStartedAt)
    })
  }
}

export function reportHostServerDeploy(
  report: HostServerReport,
  target: SshTarget,
  trace: HostServerDecisionTrace,
  result: OrcadManagedDeployResult
): void {
  if (result.outcome === 'deferred') {
    reportHostServerEvent(report, target, {
      kind: 'deploy_failed',
      context: 'deploy',
      failure: 'deferred',
      code: result.code,
      durationMs: sinceMs(trace.startedAt)
    })
  }
}

export function reportHostServerConversion(
  report: HostServerReport,
  target: SshTarget,
  trace: HostServerDecisionTrace,
  result: OrcadManagedConversionResult
): void {
  const durationMs = sinceMs(trace.conversionStartedAt)
  if (result.outcome === 'converted') {
    reportHostServerEvent(report, target, { kind: 'conversion', phase: 'committed', durationMs })
    return
  }
  const failure = result.outcome === 'deferred' ? 'deferred' : 'refused'
  const code = result.code
  reportHostServerEvent(report, target, {
    kind: 'conversion',
    phase: 'failed',
    failure,
    code,
    durationMs
  })
  if (failure === 'deferred') {
    // The conversion's own deploy is what deferred.
    reportHostServerEvent(report, target, {
      kind: 'deploy_failed',
      context: 'conversion',
      failure,
      code,
      durationMs
    })
  }
}
