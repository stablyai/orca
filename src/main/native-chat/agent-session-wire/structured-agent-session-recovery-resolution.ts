/**
 * Exits from latched recovery stages. A session lands in `recovering` / `manual-recovery`
 * when evidence about its owner was UNAVAILABLE; this module re-asks with present-time
 * evidence and releases the lease only on proof. A stop is a request — the lease moves only
 * after a later probe proves the process absent, never on a timeout.
 */

import {
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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

/** Only native records resolve here: a TUI owner has its own recovery transport, and a
 *  conflicted claim is a user decision, not missing evidence. */
export function structuredSessionRecoveryIsResolvable(record: AgentSessionRecord): boolean {
  return (
    record.lease.runtimeKind === 'native' &&
    record.lease.claimStatus !== 'conflicted' &&
    (record.lease.handoffStage === 'recovering' || record.lease.handoffStage === 'manual-recovery')
  )
}

export async function resolveStructuredSessionRecovery(
  deps: StructuredSessionRecoveryResolutionDeps,
  sessionId: string
): Promise<'resolved' | 'unresolved' | 'not-applicable'> {
  const record = deps.store.getRecord(sessionId)
  if (!record || !structuredSessionRecoveryIsResolvable(record)) {
    return 'not-applicable'
  }
  let probe = await deps.probeRecord(record)
  const owner = record.lease.ownerProcess
  if (owner && owner.hostId === deps.store.hostId && isProvenAliveProbe(probe)) {
    // The owner is a live child of a runtime that no longer exists; its transport cannot be
    // reconstructed, so the only way forward is to stop it and prove it gone.
    probe = await stopOwnerAndReprobe(deps, record, owner.pid)
  }
  try {
    await deps.store.evictProvenDeadOwner({
      sessionId,
      expectedFence: record.lease.runtimeFence,
      probe,
      now: deps.now()
    })
    return 'resolved'
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error)
    if (UNRESOLVED_REFUSALS.has(code)) {
      // No proof yet; the record is preserved untouched and the next attempt re-asks.
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
