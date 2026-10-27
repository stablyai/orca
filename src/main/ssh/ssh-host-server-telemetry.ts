/** Narrow raw connect/setup codes to fixed enums; unknowns become other, never host/user strings. */
import type { EventProps } from '../../shared/telemetry-events'
import {
  SSH_HOST_SERVER_FAILURE_VALUES,
  SSH_HOST_SERVER_REASON_VALUES,
  SSH_HOST_SERVER_REFUSAL_VALUES
} from '../../shared/telemetry-ssh-host-server-event-schemas'
import { track } from '../telemetry/client'
import type { HostServerConnectEvent } from './ssh-host-server-connect-events'
import type { SshHostPlatformFacts } from './ssh-host-platform-memo'
import type { OrcadTunnelTransport } from './orcad-tunnel-transport-memo'

type HostProps = Pick<EventProps<'ssh_host_server_decided'>, 'host_os' | 'host_arch' | 'host_libc'>
type FailureCode = (typeof SSH_HOST_SERVER_FAILURE_VALUES)[number]
type RefusalCode = (typeof SSH_HOST_SERVER_REFUSAL_VALUES)[number]
type DurationBucket = EventProps<'ssh_host_server_decided'>['duration_bucket']

function pick<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback
}

function durationBucket(durationMs: number): DurationBucket {
  if (durationMs < 5_000) {
    return 'lt_5s'
  }
  if (durationMs < 15_000) {
    return '5s_15s'
  }
  return durationMs < 60_000 ? '15s_60s' : 'gte_60s'
}

export function hostProps(facts: SshHostPlatformFacts | null): HostProps {
  return facts
    ? { host_os: facts.os, host_arch: facts.arch, host_libc: facts.libc }
    : { host_os: 'unknown', host_arch: 'unknown', host_libc: 'unknown' }
}

export function hostServerRefusal(code: string | null): RefusalCode {
  return code
    ? pick(SSH_HOST_SERVER_REFUSAL_VALUES, code.replace(/^orcad_migration_/u, ''), 'other')
    : 'none'
}

export function hostServerFailure(code: string | null): FailureCode {
  return code
    ? pick(SSH_HOST_SERVER_FAILURE_VALUES, code.replace(/^orcad_/u, ''), 'other')
    : 'other'
}

type SshHostServerMoveOutcome = EventProps<'ssh_host_server_move'>['outcome']

export function trackSshHostServerMove(
  outcome: SshHostServerMoveOutcome,
  facts: SshHostPlatformFacts | null
): void {
  try {
    track('ssh_host_server_move', { outcome, ...hostProps(facts) })
  } catch {
    // Telemetry never costs a move.
  }
}

export function trackSshHostServerEvent(
  event: HostServerConnectEvent,
  facts: SshHostPlatformFacts | null,
  transport: OrcadTunnelTransport | null = null
): void {
  const host = hostProps(facts)
  try {
    // track() applies the consent gate and validates against the strict schema.
    switch (event.kind) {
      case 'decided':
        track('ssh_host_server_decided', {
          outcome: event.outcome,
          transport: event.outcome === 'relay' ? 'none' : (transport ?? 'unknown'),
          reason: pick(SSH_HOST_SERVER_REASON_VALUES, event.reason, 'other'),
          refusal: hostServerRefusal(event.refusal),
          recorded: event.recorded,
          ...host,
          duration_bucket: durationBucket(event.durationMs)
        })
        return
      case 'conversion': {
        const failed = event.phase === 'failed'
        track('ssh_host_server_conversion', {
          phase: event.phase,
          failure: failed ? event.failure : 'none',
          refusal: failed && event.failure === 'refused' ? hostServerRefusal(event.code) : 'none',
          failure_code:
            failed && event.failure !== 'refused' ? hostServerFailure(event.code) : 'none',
          ...host,
          duration_bucket: durationBucket(event.phase === 'started' ? 0 : event.durationMs)
        })
        return
      }
      case 'deploy_failed':
        track('ssh_host_server_deploy_failed', {
          context: event.context,
          failure: event.failure,
          failure_code: hostServerFailure(event.code),
          ...host,
          duration_bucket: durationBucket(event.durationMs)
        })
    }
  } catch {
    // Telemetry never costs a connect.
  }
}
