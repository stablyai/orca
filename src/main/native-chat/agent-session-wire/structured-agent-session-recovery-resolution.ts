/** Resolve recovering owners from fresh evidence; unproven terminal or live foreign claims remain unresolved.
 * Signal only verified local POSIX owners; Windows never signals saved PIDs. Lost native transport
 * permits release without death proof, while terminal owners require proven exit. */

import {
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-supervisor'
import { releaseUnprovenAgentSessionOwner } from '../../runtime/agent-session/ownership/agent-session-lease-transitions'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type StructuredSessionRecoveryStopSignal = 'SIGTERM' | 'SIGKILL'

export type StructuredSessionRecoveryResolutionDeps = {
  store: AgentSessionRecordStore
  probeRecord: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  now: () => number
  stopOwnerProcess?: (pid: number, signal: StructuredSessionRecoveryStopSignal) => void
  delay?: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
}

const STOP_PROBE_INTERVAL_MS = 250
// Let POSIX supervisors finish group cleanup before SIGKILL; early supervisor death can orphan providers.
const STOP_PROBES: Record<StructuredSessionRecoveryStopSignal, number> = {
  SIGTERM: Math.ceil(PROVIDER_SUPERVISOR_MAX_STOP_MS / STOP_PROBE_INTERVAL_MS) + 1,
  SIGKILL: 4
}

const UNRESOLVED_REFUSALS: ReadonlySet<string> = new Set([
  'agent_session_ownership_unknown',
  'agent_session_checkpoint_stale',
  'execution_owner_reconciling',
  'agent_session_identity_required'
])

export async function resolveStructuredSessionRecovery(
  deps: StructuredSessionRecoveryResolutionDeps,
  sessionId: string
): Promise<'resolved' | 'unresolved' | 'not-applicable'> {
  const record = deps.store.getRecord(sessionId)
  if (record?.lease.handoffStage !== 'recovering') {
    return 'not-applicable'
  }
  let probe = await deps.probeRecord(record)
  const owner = record.lease.ownerProcess
  if (owner && record.lease.claimStatus === 'conflicted' && !isProvenDeadProbe(probe)) {
    // Terminal transport survives runtime restart; require proven exit.
    return 'unresolved'
  }
  if (owner && isProvenAliveProbe(probe)) {
    if (owner.hostId !== deps.store.hostId) {
      return 'unresolved'
    }
    if ((deps.platform ?? process.platform) !== 'win32') {
      probe = await stopOwnerAndReprobe(deps, record, owner.pid)
    }
  }
  try {
    await (owner && !isProvenDeadProbe(probe)
      ? deps.store.transitionHandoff(sessionId, (latest) =>
          releaseUnprovenAgentSessionOwner({
            record: latest,
            expectedFence: record.lease.runtimeFence,
            now: deps.now()
          })
        )
      : deps.store.evictProvenDeadOwner({
          sessionId,
          expectedFence: record.lease.runtimeFence,
          probe,
          now: deps.now()
        }))
    return 'resolved'
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error)
    if (UNRESOLVED_REFUSALS.has(code)) {
      // Changed ownership needs a fresh resolution attempt.
      return 'unresolved'
    }
    throw error
  }
}

async function stopOwnerAndReprobe(
  deps: StructuredSessionRecoveryResolutionDeps,
  record: AgentSessionRecord,
  pid: number
): Promise<AgentSessionOwnerProbe> {
  const stop = deps.stopOwnerProcess ?? defaultStopOwnerProcess
  const delay = deps.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let probe: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'owner stop requested' }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    // Resolution is outside serialization; changed leases no longer authorize this PID.
    if (!leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)) {
      return probe
    }
    stop(pid, signal)
    for (let attempt = 0; attempt < STOP_PROBES[signal]; attempt += 1) {
      probe = await deps.probeRecord(record)
      if (isProvenDeadProbe(probe)) {
        return probe
      }
      await delay(STOP_PROBE_INTERVAL_MS)
    }
  }
  return probe
}

function leaseStillNamesOwner(
  current: AgentSessionRecord | null,
  probed: AgentSessionRecord
): boolean {
  const owner = current?.lease.ownerProcess
  const expected = probed.lease.ownerProcess
  return (
    current?.lease.runtimeFence === probed.lease.runtimeFence &&
    owner?.pid === expected?.pid &&
    owner?.processStartTimeMs === expected?.processStartTimeMs
  )
}

function defaultStopOwnerProcess(pid: number, signal: StructuredSessionRecoveryStopSignal): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Signalling is not proof; the next probe determines exit.
  }
}
