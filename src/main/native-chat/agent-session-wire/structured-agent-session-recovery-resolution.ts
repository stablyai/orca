import {
  captureDescendantSnapshot,
  hasUnambiguousStartTime,
  hasUnambiguousStartIdentity
} from '../../pty-descendant-termination'
import { terminateDescendantSnapshotWithVerdict } from '../../pty-descendant-exit-verification'
import { readProcessStartTimeMs } from '../../runtime/agent-session-process-identity-probe'
import { readPosixProcessRow } from '../../provider-process/provider-process-row-read'
import {
  hasRecordedProviderLaunch,
  recoverProviderLaunches
} from '../../provider-process/provider-process-ledger'
/** Resolve recovering owners from fresh evidence; unproven terminal or live foreign claims remain unresolved.
 * Signal only verified local POSIX owners; Windows never signals saved PIDs. Lost native transport
 * permits release without death proof, while terminal owners require proven exit. */

import {
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-timing'
import { releaseUnprovenAgentSessionOwner } from '../../runtime/agent-session-lease-transitions'
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
  await cleanUpStructuredSessionOwner(deps, record)
  const probe = await deps.probeRecord(record)
  const owner = record.lease.ownerProcess
  if (owner && record.lease.claimStatus === 'conflicted' && !isProvenDeadProbe(probe)) {
    // Terminal transport survives runtime restart; require proven exit.
    return 'unresolved'
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

function recoverableOwner(
  deps: Pick<StructuredSessionRecoveryResolutionDeps, 'store' | 'platform'>,
  record: AgentSessionRecord
) {
  const owner = record.lease.ownerProcess
  return (deps.platform ?? process.platform) !== 'win32' &&
    owner?.hostId === deps.store.hostId &&
    record.lease.claimStatus !== 'conflicted'
    ? owner
    : null
}

/** Recorded tools must recover before restart adjudication can erase their dead root. */
export async function recoverRecordedStructuredSessionLaunches(
  deps: Pick<StructuredSessionRecoveryResolutionDeps, 'store' | 'platform'>,
  record: AgentSessionRecord
): Promise<void> {
  const owner = recoverableOwner(deps, record)
  if (owner) {
    await recoverProviderLaunches(owner.pid)
  }
}

/** A retained legacy owner gets its full stop opportunity before recovery releases its claim. */
export async function cleanUpStructuredSessionOwner(
  deps: StructuredSessionRecoveryResolutionDeps,
  record: AgentSessionRecord
): Promise<void> {
  const owner = recoverableOwner(deps, record)
  if (!owner) {
    return
  }
  await recoverProviderLaunches(owner.pid)
  if (await hasRecordedProviderLaunch(owner.pid, owner.processStartTimeMs ?? undefined)) {
    return
  }
  if (!isProvenAliveProbe(await deps.probeRecord(record))) {
    return
  }
  const matches = async (): Promise<boolean> => {
    if (!leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)) {
      return false
    }
    const boundary = Date.now()
    const row = await readPosixProcessRow(owner.pid)
    if (
      !row ||
      row === 'unverifiable' ||
      (row.startResolution === 'second' && !hasUnambiguousStartTime(row.startedAt, boundary))
    ) {
      return false
    }
    return (await readProcessStartTimeMs(owner.pid)) === owner.processStartTimeMs
  }
  if (!(await matches())) {
    return
  }
  const captured = await captureDescendantSnapshot(owner.pid)
  if (!(await matches())) {
    return
  }
  const snapshot = captured && {
    ...captured,
    descendants: captured.descendants.filter((row) =>
      hasUnambiguousStartIdentity(
        row,
        captured.capturedAtMsByPid?.[String(row.pid)] ?? captured.capturedAtMs
      )
    )
  }
  const stop = deps.stopOwnerProcess ?? defaultStopOwnerProcess
  const delay =
    deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  stopLadder: for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (
      !(await matches()) ||
      !leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)
    ) {
      break
    }
    stop(owner.pid, signal)
    for (let attempt = 0; attempt < STOP_PROBES[signal]; attempt += 1) {
      const probe = await deps.probeRecord(record)
      if (isProvenDeadProbe(probe)) {
        break stopLadder
      }
      await delay(STOP_PROBE_INTERVAL_MS)
    }
  }
  if (snapshot && leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)) {
    await terminateDescendantSnapshotWithVerdict(snapshot, {
      requireIdentityBeforeSignal: true,
      sendSignal: (pid, signal) => {
        if (
          (signal === 'SIGTERM' || signal === 'SIGKILL') &&
          leaseStillNamesOwner(deps.store.getRecord(record.sessionId), record)
        ) {
          stop(pid, signal)
        }
      }
    })
  }
}

function leaseStillNamesOwner(
  current: AgentSessionRecord | null,
  probed: AgentSessionRecord
): boolean {
  const owner = current?.lease.ownerProcess
  const expected = probed.lease.ownerProcess
  return (
    current?.lease.runtimeFence === probed.lease.runtimeFence &&
    current?.lease.claimKeyId === probed.lease.claimKeyId &&
    current?.lease.claimStatus === probed.lease.claimStatus &&
    current?.lease.reservedSpawnToken === probed.lease.reservedSpawnToken &&
    owner?.hostId === expected?.hostId &&
    owner?.spawnToken === expected?.spawnToken &&
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
