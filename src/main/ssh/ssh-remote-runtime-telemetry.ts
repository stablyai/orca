/**
 * `ssh_remote_runtime_resolved` (design D6): once per host and outcome per app session, enum-only.
 * The dedupe key is the local target id, which never leaves this process.
 */
import type { SshRemoteRuntimeRung } from '../../shared/ssh-types'
import type { EventProps } from '../../shared/telemetry-events'
import {
  SSH_RUNTIME_GLIBC_MINOR_VALUES,
  SSH_RUNTIME_HOST_NODE_MAJOR_VALUES,
  SSH_RUNTIME_REFUSAL_VALUES
} from '../../shared/telemetry-ssh-runtime-event-schemas'
import { track } from '../telemetry/client'
import type { OrcadDeploymentTargetFacts } from './orcad-deployment-target'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import type { HostNodeVersion } from './ssh-remote-node-toolchain-probe'

type Props = EventProps<'ssh_remote_runtime_resolved'>
export type SshRemoteRuntimeOutcome = Props['outcome']

export type SshRemoteRuntimeResolvedFacts = {
  rung: SshRemoteRuntimeRung
  outcome: SshRemoteRuntimeOutcome
  host: RemoteHostPlatform
  facts: OrcadDeploymentTargetFacts | null
  firstRefusal: string | null
  selfTest: Props['self_test']
  runtimeTransfer: Props['runtime_transfer']
  hostNode: HostNodeVersion | null
  durationMs: number
}

const reportedHosts = new Set<string>()

const RUNG_VALUES: Record<SshRemoteRuntimeRung, Props['rung']> = {
  A: 'a',
  B: 'b',
  C: 'c',
  D: 'd',
  legacy: 'legacy'
}

function pick<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback
}

export function glibcMinorBucket(facts: OrcadDeploymentTargetFacts | null): Props['glibc_minor'] {
  const glibc = facts?.glibc
  if (!glibc || glibc.major !== 2) {
    return 'none'
  }
  if (glibc.minor < 17) {
    return 'below_17'
  }
  return pick(SSH_RUNTIME_GLIBC_MINOR_VALUES, String(glibc.minor), 'above_42')
}

export function durationBucket(durationMs: number): Props['duration_bucket'] {
  if (durationMs < 5_000) {
    return 'lt_5s'
  }
  if (durationMs < 15_000) {
    return '5s_15s'
  }
  return durationMs < 60_000 ? '15s_60s' : 'gte_60s'
}

function hostLibc(
  facts: OrcadDeploymentTargetFacts | null,
  host: RemoteHostPlatform
): Props['host_libc'] {
  if (host.os !== 'linux') {
    return 'none'
  }
  if (!facts) {
    return 'unknown'
  }
  return facts.target.endsWith('-musl') ? 'musl' : 'glibc'
}

export function sshRemoteRuntimeResolvedProps(input: SshRemoteRuntimeResolvedFacts): Props {
  const hostNodeMajor = input.hostNode
    ? pick(SSH_RUNTIME_HOST_NODE_MAJOR_VALUES, String(input.hostNode.major), 'above_30')
    : null
  return {
    rung: RUNG_VALUES[input.rung],
    host_os: input.host.os,
    host_arch: input.host.arch,
    host_libc: hostLibc(input.facts, input.host),
    glibc_minor: glibcMinorBucket(input.facts),
    first_refusal: pick(SSH_RUNTIME_REFUSAL_VALUES, input.firstRefusal ?? 'none', 'none'),
    self_test: input.selfTest,
    runtime_transfer: input.runtimeTransfer,
    ...(hostNodeMajor ? { host_node_major: hostNodeMajor } : {}),
    duration_bucket: durationBucket(input.durationMs),
    outcome: input.outcome
  }
}

export function trackSshRemoteRuntimeResolved(
  hostKey: string,
  input: SshRemoteRuntimeResolvedFacts
): void {
  // Why per outcome: an unverifiable attempt must not use up the host's later resolved report.
  const key = `${input.outcome}:${hostKey}`
  if (reportedHosts.has(key)) {
    return
  }
  reportedHosts.add(key)
  try {
    // track() applies the existing consent gate and validates against the strict schema.
    track('ssh_remote_runtime_resolved', sshRemoteRuntimeResolvedProps(input))
  } catch {
    // Telemetry never costs a connect.
  }
}

export function resetSshRemoteRuntimeTelemetryForTests(): void {
  reportedHosts.clear()
}
