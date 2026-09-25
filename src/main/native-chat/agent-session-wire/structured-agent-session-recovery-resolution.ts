/**
 * Exits from the `recovering` stage (and the legacy `manual-recovery` one). A session lands there
 * when evidence about its owner was unavailable; this re-asks with present-time evidence and always
 * concludes. A dead owner is evicted on proof. A live one is stopped by identity and evicted once
 * proven gone. One that outlives the stop, or whose identity cannot be verified, is released
 * anyway: its transport died with the runtime that held it, so nothing can drive it, and no signal
 * is sent to a pid that cannot be verified as the one recorded. Only a conflicted claim, which is
 * how a terminal owner an older build recorded now loads, is waited out and never stopped: it is
 * the user's own agent, and its exit is its way out.
 */

import {
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { releaseUnprovenAgentSessionOwner } from '../../runtime/agent-session-lease-transitions'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type StructuredSessionRecoveryStopSignal = 'SIGTERM' | 'SIGKILL'

export type StructuredSessionRecoveryResolutionDeps = {
  store: AgentSessionRecordStore
  probeRecord: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  now: () => number
  stopOwnerProcess?: (pid: number, signal: StructuredSessionRecoveryStopSignal) => void
  delay?: (ms: number) => Promise<void>
}

const STOP_PROBES_PER_SIGNAL = 4
const STOP_PROBE_INTERVAL_MS = 250

const UNRESOLVED_REFUSALS: ReadonlySet<string> = new Set([
  'agent_session_ownership_unknown',
  'agent_session_checkpoint_stale',
  'execution_owner_reconciling',
  'agent_session_identity_required'
])

function isRecoveryStage(record: AgentSessionRecord): boolean {
  return (
    record.lease.handoffStage === 'recovering' || record.lease.handoffStage === 'manual-recovery'
  )
}

export async function resolveStructuredSessionRecovery(
  deps: StructuredSessionRecoveryResolutionDeps,
  sessionId: string
): Promise<'resolved' | 'unresolved' | 'not-applicable'> {
  const record = deps.store.getRecord(sessionId)
  if (!record || !isRecoveryStage(record)) {
    return 'not-applicable'
  }
  let probe = await deps.probeRecord(record)
  const owner = record.lease.ownerProcess
  if (owner && record.lease.claimStatus === 'conflicted' && !isProvenDeadProbe(probe)) {
    // A terminal agent keeps its transport across a restart, so only proof of its exit is a way in.
    return 'unresolved'
  }
  if (owner && isProvenAliveProbe(probe)) {
    if (owner.hostId !== deps.store.hostId) {
      return 'unresolved'
    }
    probe = await stopOwnerAndReprobe(deps, record, owner.pid)
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
      // The record moved under this resolution; the next attempt re-asks against what it is now.
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
    stop(pid, signal)
    for (let attempt = 0; attempt < STOP_PROBES_PER_SIGNAL; attempt += 1) {
      probe = await deps.probeRecord(record)
      if (isProvenDeadProbe(probe)) {
        return probe
      }
      await delay(STOP_PROBE_INTERVAL_MS)
    }
  }
  return probe
}

function defaultStopOwnerProcess(pid: number, signal: StructuredSessionRecoveryStopSignal): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone or not ours to signal; the next probe supplies the actual proof.
  }
}
