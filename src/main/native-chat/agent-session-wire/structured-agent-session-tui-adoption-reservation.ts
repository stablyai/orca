/**
 * The reservation an adopted Codex TUI needs BEFORE it may talk to the provider.
 *
 * Adoption proves the running Codex by typing `/status` into its own pane, and
 * `agentSessionPtyWriteGate.admitProof` admits that probe only against a durable reservation that
 * already names this session, this runtime kind, and this spawn token. Reserving after the proof —
 * the shape this replaces — meant the probe was never admitted, so no adoption could ever succeed.
 *
 * The reservation is therefore created first and released again when the proof does not land, so a
 * failed attempt leaves nothing behind that would refuse the next one.
 */

import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation,
  AgentSessionLaunchEnv,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { classifyStoreFailure } from './structured-agent-session-attach'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps
} from './structured-agent-session-host-types'

export type StructuredTuiAdoptionReservationRequest = {
  caller: StructuredAgentSessionCaller
  sessionId: string
  clientOperationId: string
  /** The adoption call's own payload fingerprint; the durable operation row is keyed by it. */
  fingerprint: string
  location: AgentSessionExecutionLocation
  provider: AgentSessionHandleProvider
  accountHome: AgentSessionAccountHome
  spawnToken: string
  claimKeyId: string
  launchEnv?: AgentSessionLaunchEnv
}

export type StructuredTuiAdoptionReservationResult =
  | {
      ok: true
      fence: number
      /** The token the proof must carry: a replayed call keeps the one already on the record. */
      spawnToken: string
    }
  | { ok: false; refusal: AgentSessionWireRefusal }

export type StructuredTuiAdoptionReservationRelease = {
  sessionId: string
  fence: number
  spawnToken: string
}

/** The exact lease shape `admitProof` accepts as `provingReservation`. */
export function isStructuredTuiAdoptionReservation(
  record: AgentSessionRecord,
  spawnToken: string
): boolean {
  const { lease } = record
  return (
    lease.runtimeKind === 'tui' &&
    lease.claimStatus === 'reserved' &&
    lease.handoffStage === 'new-owner-proving' &&
    (lease.ownerProcess === null || lease.ownerProcess.spawnToken === spawnToken) &&
    lease.reservedSpawnToken === spawnToken &&
    !lease.unreconciled
  )
}

export async function reserveStructuredTuiAdoption(
  input: StructuredTuiAdoptionReservationRequest & {
    deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'probeOwner'>
    now: () => number
  }
): Promise<StructuredTuiAdoptionReservationResult> {
  const { deps, sessionId } = input
  const existing = deps.store.getRecord(sessionId)
  try {
    const reserved = await deps.store.reserveOwner({
      sessionId,
      location: input.location,
      provider: input.provider,
      accountHome: input.accountHome,
      ...(input.launchEnv ? { launchEnv: input.launchEnv } : {}),
      runtimeKind: 'tui',
      // An adoption never declares a fence, so the compare-and-swap runs against what the store
      // holds right now and the probe below is what refuses when that record still has an owner.
      expectedFence: existing?.lease.runtimeFence ?? null,
      spawnToken: input.spawnToken,
      claimKeyId: input.claimKeyId,
      // Why null: a retry mints a fresh operation id, and a non-null one here would make the
      // reservation left behind by the previous attempt refuse it as a different operation.
      handoffOperationId: null,
      probe: await previousOwnerProbe(input, existing),
      operation: {
        callerKey: input.caller.callerKey,
        operationId: input.clientOperationId,
        fingerprint: input.fingerprint
      },
      now: input.now()
    })
    const spawnToken = reserved.record.lease.reservedSpawnToken
    if (!spawnToken) {
      throw new Error('agent_session_ownership_unknown')
    }
    return { ok: true, fence: reserved.record.lease.runtimeFence, spawnToken }
  } catch (error) {
    const current = deps.store.getRecord(sessionId)
    return {
      ok: false,
      refusal: classifyStoreFailure(error, current?.lease.runtimeFence ?? null, current)
    }
  }
}

/**
 * Undo a reservation whose proof never landed. Adoption only attributes its synthetic token to an
 * existing process, so clearing a partially committed identity truthfully restores the durable
 * "nothing spawned under this token" proof needed by the next attempt.
 */
export async function releaseStructuredTuiAdoptionReservation(
  input: StructuredTuiAdoptionReservationRelease & {
    deps: Pick<StructuredAgentSessionHostDeps, 'store'>
    now: () => number
  }
): Promise<void> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (
    !record ||
    record.lease.runtimeFence !== input.fence ||
    !isStructuredTuiAdoptionReservation(record, input.spawnToken)
  ) {
    // Superseded, already proven, or gone: whatever holds the record now is not this attempt's.
    return
  }
  const now = input.now()
  await input.deps.store.transitionHandoff(input.sessionId, (current) => {
    if (
      current.lease.runtimeFence !== input.fence ||
      !isStructuredTuiAdoptionReservation(current, input.spawnToken)
    ) {
      return current
    }
    return {
      ...current,
      lease: { ...current.lease, ownerProcess: null, processlessAt: now },
      updatedAt: now
    }
  })
}

function previousOwnerProbe(
  input: { deps: Pick<StructuredAgentSessionHostDeps, 'probeOwner'> },
  existing: AgentSessionRecord | null
): Promise<AgentSessionOwnerProbe> | AgentSessionOwnerProbe {
  if (!existing) {
    return { outcome: 'reservation-unused' }
  }
  // Fails closed: without a prober the store must not be told the previous owner is gone.
  return (
    input.deps.probeOwner?.(existing) ?? {
      outcome: 'indeterminate',
      reason: 'this host cannot probe the recorded owner'
    }
  )
}
